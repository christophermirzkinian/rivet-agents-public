import { cpSync, createReadStream, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const PDFJS = resolve(fileURLToPath(new URL("./node_modules/pdfjs-dist/", import.meta.url)));
const PDFJS_DIRS = ["cmaps", "iccs", "standard_fonts", "wasm"];
/** pdf.js's scripting engine: the viewer never runs a PDF's scripts. */
const unused = (path: string) => basename(path).startsWith("quickjs");

/** pdf.js's decoders, CMaps, ICC profiles and standard fonts at /pdfjs/, fetched by the PDF viewer as a PDF needs them. */
function pdfjsAssets(): Plugin {
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (request, response, next) => {
        const path = decodeURIComponent((request.url ?? "").split("?")[0]!);
        const file = resolve(PDFJS, `.${path.startsWith("/") ? path : `/${path}`}`);
        const dir = path.split("/").filter(Boolean)[0] ?? "";
        if (!file.startsWith(PDFJS + sep) || !PDFJS_DIRS.includes(dir) || unused(file) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return next();
        response.setHeader("content-type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        createReadStream(file).pipe(response);
      });
    },
    writeBundle(options) {
      for (const dir of PDFJS_DIRS) cpSync(join(PDFJS, dir), join(options.dir!, "pdfjs", dir), { recursive: true, filter: (path) => !unused(path) });
    },
  };
}

// The web app lives in web/ and builds into dist/web, which the server serves.
// In dev, /api goes to the local server.
export default defineConfig({
  root: "web",
  build: { outDir: "../dist/web", emptyOutDir: true },
  plugins: [pdfjsAssets()],
  server: {
    port: 5230,
    proxy: { "/api": "http://127.0.0.1:8130" },
  },
});
