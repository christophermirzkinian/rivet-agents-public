import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

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

function send(request: IncomingMessage, response: ServerResponse, file: string, cacheControl: string): void {
  response.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": cacheControl,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
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
      send(request, response, file, hashed ? "public, max-age=31536000, immutable" : "no-cache");
      return true;
    }
  }

  const acceptsHtml = (request.headers.accept ?? "").includes("text/html");
  if (path !== "/" && !acceptsHtml) return false;
  const index = join(root, "index.html");
  if (!(await fileAt(root, "/index.html"))) return false;
  send(request, response, index, "no-cache");
  return true;
}
