import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";

import { APP_NAME, appName } from "../shared/names.js";
import { onHostedMachine } from "./hosted-name.js";

/** Files with the app's name in them: a hosted machine serves them with its host's name, read before anyone signs in. */
const NAMED = ["index.html", "manifest.webmanifest", "sw.js"];
/** A hosted machine's page says so even when its app has the build's own name (cloud-agent.ts readServedApp). */
const HOSTED_MARK = '<meta name="hosted-agent" content="1" />';
/** The built description is the owner's; a hosted machine's page and manifest, and their link previews, read this. */
const HOSTED_DESCRIPTION = "Your agent: answer the cards, run the crew.";
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Which named file at the root this is, by the file itself (its device and inode), never by the spelling asked for: a
 * case-blind file system folds more than toLowerCase does (/manifeſt.webmanifest finds manifest.webmanifest). Null for
 * any other file.
 */
async function rootName(root: string, file: string): Promise<string | null> {
  if (dirname(file) !== root) return null;
  const own = await stat(file).catch(() => null);
  if (!own) return null;
  for (const name of NAMED) {
    const named = await stat(join(root, name)).catch(() => null);
    if (named && named.dev === own.dev && named.ino === own.ino) return name;
  }
  return null;
}

function withMark(page: string): string {
  const head = page.search(/<\/head\s*>/i);
  const body = head >= 0 ? head : page.search(/<body[\s>]/i);
  // Anything before the doctype puts the browser in quirks mode.
  const at = body >= 0 ? body : (/^\s*(?:<!doctype\b[^>]*>\s*)?(?:<html\b[^>]*>\s*)?(?:<head\b[^>]*>)?/i.exec(page)?.[0].length ?? 0);
  return page.slice(0, at) + HOSTED_MARK + page.slice(at);
}

const hostedDescriptions = (page: string): string =>
  page.replace(/<meta\b[^>]*>/gi, (tag) =>
    /\b(?:name|property)\s*=\s*["']?(?:og:|twitter:)?description["'\s/>]/i.test(tag)
      ? tag.replace(/(\bcontent\s*=\s*)(["'])[\s\S]*?\2/i, `$1$2${HOSTED_DESCRIPTION}$2`)
      : tag,
  );

/**
 * A hosted machine's manifest: its own description, and the host's app as the short name under the home-screen icon (the
 * build's short name is the bare product name, which the full-name rename never matches).
 */
function hostedManifest(text: string): string {
  const fields: Record<string, string> = { description: HOSTED_DESCRIPTION, short_name: appName() };
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return text.replace(/("(description|short_name)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (_, key: string, field: string) => `${key}${JSON.stringify(fields[field])}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return text;
  const own = Object.fromEntries(Object.entries(fields).filter(([field]) => field in manifest));
  return Object.keys(own).length ? JSON.stringify({ ...manifest, ...own }, null, 2) : text;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  // pdf.js's decoders, CMaps and standard fonts (vite.config.ts copies them to /pdfjs/).
  ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream",
  ".icc": "application/vnd.iccprofile",
  ".pfb": "application/x-font-type1",
  ".ttf": "font/ttf",
};

async function fileAt(root: string, relative: string): Promise<string | null> {
  const target = resolve(root, `.${relative}`);
  if (target !== root && !target.startsWith(root + sep)) return null;
  try {
    return (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

async function send(request: IncomingMessage, response: ServerResponse, root: string, file: string, cacheControl: string): Promise<void> {
  const name = await rootName(root, file);
  const renamed = appName() !== APP_NAME && name !== null && NAMED.includes(name);
  const page = onHostedMachine() && name === "index.html";
  const manifest = onHostedMachine() && name === "manifest.webmanifest";
  const read = renamed || page || manifest ? await readFile(file, "utf8") : null;
  const named = read !== null && renamed ? read.replaceAll(APP_NAME, escapeHtml(appName())) : read;
  const text = named === null ? null : page ? withMark(hostedDescriptions(named)) : manifest ? hostedManifest(named) : named;
  response.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": cacheControl,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  if (text !== null) response.end(text);
  else createReadStream(file).pipe(response);
}

/** Serves the built web app; returns false when nothing matched. */
export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  webRoot: string,
  rawPath: string,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const root = resolve(webRoot);
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (path.includes("\0") || path.includes("\\")) return false;

  if (path !== "/" && !path.endsWith("/")) {
    const file = await fileAt(root, path);
    if (file) {
      const hashed = path.startsWith("/assets/");
      await send(request, response, root, file, hashed ? "public, max-age=31536000, immutable" : "no-cache");
      return true;
    }
  }

  const acceptsHtml = (request.headers.accept ?? "").includes("text/html");
  if (path !== "/" && !acceptsHtml) return false;
  const index = join(root, "index.html");
  if (!(await fileAt(root, "/index.html"))) return false;
  await send(request, response, root, index, "no-cache");
  return true;
}
