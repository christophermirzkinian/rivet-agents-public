import { constants, type Stats } from "node:fs";
import { lstat, open, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream";

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
async function rootName(root: string, file: string, own: Stats): Promise<string | null> {
  if (dirname(file) !== root) return null;
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

type Opened = { file: string; handle: FileHandle; own: Stats };
const STALLED_MS = 60_000;

/** The build ships no dotfile or dot-folder (web/public, vite.config.ts), so none is served: .env, .git, a "..". */
const dotted = (path: string, separator: string): boolean => path.split(separator).some((part) => part.startsWith("."));

const inside = (root: string, file: string): boolean => file.startsWith(root + sep) && !dotted(file.slice(root.length), sep);

/**
 * Where the open file is now, when that is inside the root. O_NOFOLLOW guards only the last part of the path: a folder
 * above it swapped for a link between the realpath and the open leads the open out of the root.
 */
async function openedAt(root: string, file: string, handle: FileHandle, own: Stats): Promise<string | null> {
  const named = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
  if (named !== null) return inside(root, named) ? named : null;
  // Best effort with no /proc (macOS): the path, resolved again, has to lead inside the root to this same file. lstat,
  // not stat: a last part swapped for a link to the opened file after the realpath is a link, never that file.
  const again = await realpath(file).catch(() => null);
  if (!again || !inside(root, again)) return null;
  const found = await lstat(again).catch(() => null);
  return found && found.dev === own.dev && found.ino === own.ino ? again : null;
}

/**
 * The file a request names, opened: by its real path, which has to be inside the real root, so a link inside the root
 * that leads out of it, or to a dotfile, is refused. The open file is the one served, never the path read again.
 */
async function fileAt(root: string, relative: string): Promise<Opened | "refused" | null> {
  const real = await realpath(resolve(root, `.${relative}`)).catch(() => null);
  if (!real) return null;
  if (!inside(root, real)) return "refused";
  // O_NONBLOCK: a FIFO swapped in would otherwise hold the open until something writes to it.
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  const own = await handle.stat().catch(() => null);
  const file = own?.isFile() ? await openedAt(root, real, handle, own) : undefined;
  if (own && file) return { file, handle, own };
  await handle.close();
  return file === null ? "refused" : null;
}

async function send(request: IncomingMessage, response: ServerResponse, root: string, opened: Opened, cacheControl: string): Promise<void> {
  const { file, handle, own } = opened;
  let text: string | null;
  try {
    const name = await rootName(root, file, own);
    const renamed = appName() !== APP_NAME && name !== null && NAMED.includes(name);
    const page = onHostedMachine() && name === "index.html";
    const manifest = onHostedMachine() && name === "manifest.webmanifest";
    const read = renamed || page || manifest ? await handle.readFile("utf8") : null;
    const named = read !== null && renamed ? read.replaceAll(APP_NAME, escapeHtml(appName())) : read;
    text = named === null ? null : page ? withMark(hostedDescriptions(named)) : manifest ? hostedManifest(named) : named;
  } catch (err) {
    await handle.close();
    throw err;
  }
  const head = request.method === "HEAD";
  if (head || text !== null) await handle.close();
  // The server's own timeouts end at the request: a client that stops reading would hold the file open for good.
  response.setTimeout(STALLED_MS, () => response.destroy());
  response.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": cacheControl,
  });
  if (head) response.end();
  else if (text !== null) response.end(text);
  // pipeline, not pipe: a reader that goes away closes the file too.
  else pipeline(handle.createReadStream(), response, () => {});
}

/** Serves the built web app; returns false when nothing matched. */
export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  webRoot: string,
  rawPath: string,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (path.includes("\0") || path.includes("\\") || dotted(path, "/")) return false;
  const root = await realpath(resolve(webRoot)).catch(() => null);
  if (!root) return false;

  if (path !== "/" && !path.endsWith("/")) {
    const file = await fileAt(root, path);
    if (file === "refused") return false;
    if (file) {
      const hashed = file.file.startsWith(join(root, "assets") + sep);
      await send(request, response, root, file, hashed ? "public, max-age=31536000, immutable" : "no-cache");
      return true;
    }
  }

  const acceptsHtml = (request.headers.accept ?? "").includes("text/html");
  if (path !== "/" && !acceptsHtml) return false;
  const index = await fileAt(root, "/index.html");
  if (!index || index === "refused") return false;
  await send(request, response, root, index, "no-cache");
  return true;
}
