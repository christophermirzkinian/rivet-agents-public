// Rivet's sheet with the keyboard up (the visual viewport shrunk to what a keyboard leaves), a photo attached and a long
// message typed key by key: More topics and the composer must not move while you type.
// Usage, from rivet/: node web/preview/typing-jump.mjs --photo <png> [--shots <dir>]
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(`${root}/package.json`);
const pw = await import(require.resolve("playwright"));
const chromium = pw.chromium ?? pw.default.chromium;
const vite = await import(require.resolve("vite"));
const createServer = vite.createServer ?? vite.default.createServer;
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? resolve(process.argv[at + 1]) : null;
};
const photo = arg("--photo");
const shots = arg("--shots");
if (shots) mkdirSync(shots, { recursive: true });

const TEXT =
  "Before the next release, can we check the sign-up names so nothing rude or out of place gets through? A list of banned words first, then a quick read by a model to catch anyone trying to slip past the list. And while you are in there, the message box and More topics jump up and down on every key I press, which makes a long message hard to type.";

const server = await createServer({ root: `${root}/web`, configFile: `${root}/vite.config.ts`, logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const { local } = server.resolvedUrls;
const base = local[0];
const browser = await chromium.launch();
let bad = 0;
try {
  // Height: the screen a phone's keyboard leaves on each phone.
  for (const [w, hgt, kb, dpr] of [
    [390, 844, 434, 3],
    [320, 568, 287, 2],
  ]) {
    const context = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log(`pageerror ${error.message}`));
    await page.goto(`${base}preview/desktop.html?tab=progress&pictured=1`);
    await page.waitForSelector(".desk.is-rivet", { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.locator('.home-dock [data-key="rivet"]').first().click();
    await page.waitForSelector(".rivet-sheet .home-chat .chat-compose-box textarea", { timeout: 8000 });
    await page.waitForTimeout(800);
    if (photo) await page.locator(".rivet-sheet .attach-input").first().setInputFiles(photo);
    await page.waitForTimeout(800);
    const text = page.locator(".rivet-sheet .chat-compose-box textarea").first();
    await text.focus();
    // The keyboard as Android Chrome has it: the page keeps its height and only the visual viewport shrinks.
    await page.evaluate((height) => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, get: () => height });
      window.visualViewport.dispatchEvent(new Event("resize"));
    }, kb);
    await page.waitForTimeout(800);
    // The first part on the real keyboard, until the box is at its full height; then the whole box in view, as a phone's
    // Chrome shows it above the keyboard (a desktop browser shows only the caret's line).
    let typed = 0;
    while (typed < TEXT.length - 80 && (await text.evaluate((t) => t.offsetHeight)) < 180) await page.keyboard.type(TEXT[typed++]);
    await page.locator(".rivet-sheet .chat-compose-box").first().evaluate((box) => box.scrollIntoView({ block: "nearest" }));
    await page.waitForTimeout(300);
    // Then each key as the page sees it, one frame apart: the input, then what is on screen. A real keyboard also scrolls
    // its caret back into view, which hides the jump in a desktop browser; a phone does that frames later, so it shows there.
    const frames = [];
    for (const ch of TEXT.slice(typed)) {
      frames.push(
        await page.evaluate(
          (key) =>
            new Promise((done) => {
              const host = document.querySelector(".rivet-sheet .home-chat");
              const t = document.querySelector(".rivet-sheet textarea");
              t.value += key;
              t.scrollTop = t.scrollHeight;
              t.dispatchEvent(new Event("input", { bubbles: true }));
              requestAnimationFrame(() => {
                const row = document.querySelector(".rivet-sheet .chat-topics-row").getBoundingClientRect();
                const box = document.querySelector(".rivet-sheet .chat-compose-box").getBoundingClientRect();
                done([Math.round(host.scrollTop), Math.round(row.bottom), Math.round(box.bottom), Math.round(t.offsetHeight)]);
              });
            }),
          ch,
        ),
      );
    }
    const sheetBottom = await page.evaluate(() => Math.round(document.querySelector(".rivet-sheet .home-chat").getBoundingClientRect().bottom));
    // Nothing may move: the scroll, More topics and the box stay where they are, the box above the sheet's bottom.
    const late = frames;
    const scrolls = new Set(late.map((f) => f[0]));
    const rows = new Set(late.map((f) => f[1]));
    const bottoms = new Set(late.map((f) => f[2]));
    const cut = late.filter((f) => f[2] > sheetBottom + 4).length;
    const ok = late.length > 50 && scrolls.size === 1 && rows.size === 1 && bottoms.size === 1 && cut === 0;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${w}x${kb}: ${late.length} keys; scroll ${[...scrolls].join(",")} More topics bottom ${[...rows].join(",")} box bottom ${[...bottoms].join(",")} (sheet ${sheetBottom}) cut ${cut}`);
    if (shots) await page.screenshot({ path: `${shots}/typing-${w}.png` });
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(bad ? 1 : 0);
