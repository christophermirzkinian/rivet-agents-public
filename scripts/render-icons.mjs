#!/usr/bin/env node
/**
 * Renders the app's icon set from two hand-written SVGs in web/public:
 *   icon.svg  → icon-192.png, icon-512.png, icon-maskable-512.png (art inset to
 *               the 80% safe zone) and apple-touch-icon.png (180 px, opaque)
 *   badge.svg → badge-96.png, badge-72.png, badge-48.png, the Android
 *               notification badge. Android draws it from its alpha channel
 *               only, so the art is one white shape on a transparent ground; a
 *               coloured or opaque image shows as a white square.
 * To change the logo (say, after a rename), edit the two SVGs and run:
 *   node rivet/scripts/render-icons.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "public");
const BACKING = "#100e19";
const icon = readFileSync(join(pub, "icon.svg"), "utf8");
const badge = readFileSync(join(pub, "badge.svg"), "utf8");

/** @type {{ file: string, svg: string, size: number, inset?: number, opaque?: boolean }[]} */
const outputs = [
  { file: "icon-192.png", svg: icon, size: 192, opaque: true },
  { file: "icon-512.png", svg: icon, size: 512, opaque: true },
  { file: "icon-maskable-512.png", svg: icon, size: 512, inset: 0.8, opaque: true },
  { file: "apple-touch-icon.png", svg: icon, size: 180, opaque: true },
  ...[96, 72, 48].map((size) => ({ file: `badge-${size}.png`, svg: badge, size })),
];

const browser = await chromium.launch();
try {
  for (const out of outputs) {
    const page = await browser.newPage({ viewport: { width: out.size, height: out.size }, deviceScaleFactor: 1 });
    const art = Math.round(out.size * (out.inset ?? 1));
    await page.setContent(
      `<style>html,body{margin:0;width:${out.size}px;height:${out.size}px;display:grid;place-items:center;background:${out.opaque ? BACKING : "transparent"}}` +
        `svg{display:block;width:${art}px;height:${art}px}</style>${out.svg}`,
    );
    await page.screenshot({ path: join(pub, out.file), omitBackground: !out.opaque });
    await page.close();
  }
} finally {
  await browser.close();
}
