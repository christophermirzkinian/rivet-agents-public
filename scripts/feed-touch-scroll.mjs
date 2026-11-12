#!/usr/bin/env node
/**
 * Fails when a finger cannot scroll the phone's Decide sheet through a whole card or the whole Answered list: a large
 * phone-sized viewport and a small one. Serves the dev preview (web/preview/desktop.html,
 * fake data) with Vite and swipes with real touch events, not scrollTo: up from the middle of what shows until the foot
 * shows, then down until the top shows again. A phone has no Feed list: Cards opens the Decide sheet, one card at a time with Skip, so the rows a
 * finger must reach are a card taller than the sheet and Answered's rows. A card whose own scroll kept the swipe
 * (overscroll-behavior: contain) left the rows out of reach. The Feed's news runs are gone with it: the sheet
 * shows no update cards. Each leg fails unless what it swipes runs past the sheet.
 *   node rivet/scripts/feed-touch-scroll.mjs [--video <dir>] [--shots <dir>]
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : null;
};
const video = arg("--video");
const shots = arg("--shots");
for (const dir of [video, shots]) if (dir) mkdirSync(dir, { recursive: true });

/** The preview's tallest card: it runs past the sheet on both phones. */
const TALL = "ace-straight-climb";
const PHONES = [
  { name: "390", viewport: { width: 390, height: 844 } },
  { name: "320", viewport: { width: 320, height: 568 } },
].flatMap((phone) => [
  { ...phone, name: `${phone.name} card`, leg: "card" },
  { ...phone, name: `${phone.name} answered`, leg: "answered" },
]);
/**
 * More swipes than a phone needs to cross a card or list one way: one per reach of its overflow (a swipe moves at
 * least that), and ten spare. A fixed 30 ran out at 320 wide on the old Feed while still
 * moving. A finger that stops scrolling still fails at the limit.
 */
const swipesFor = (overflow, reach) => Math.ceil(overflow / reach) + 10;

const server = await createServer({ root: join(root, "web"), configFile: join(root, "vite.config.ts"), logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const { local: [base] } = server.resolvedUrls;
const browser = await chromium.launch();
const failures = [];
try {
  for (const phone of PHONES) {
    const context = await browser.newContext({
      viewport: phone.viewport,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      ...(video ? { recordVideo: { dir: video, size: phone.viewport } } : {}),
    });
    const page = await context.newPage();
    if (phone.leg === "card") {
      await page.goto(`${base}preview/desktop.html?tab=cards&top=${TALL}`);
      await page.waitForSelector(`.decide-sheet .decide-card .card.top[data-need="${TALL}"] .card-body`);
    } else {
      await page.goto(`${base}preview/desktop.html?tab=cards`);
      await page.click('.decide-seg[data-seg="answered"]');
      // Every answer the preview has: all hours, and the done ones too.
      await page.click('.decide-card [data-window="all"]');
      if ((await page.getAttribute(".decide-card .ans-done", "aria-checked")) !== "true") await page.click(".decide-card .ans-done");
      await page.waitForSelector(".decide-card.is-list .ans-row");
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    const cdp = await context.newCDPSession(page);
    const label = phone.name;
    const scroller = phone.leg === "card" ? ".decide-sheet .decide-card .card.top" : ".decide-sheet .decide-card.is-list";
    const lastSel = phone.leg === "card" ? ":scope > *" : ".ans-row";

    /** Where the card or list is: its scroll, the middle of what shows of it, and whether its top and foot show. */
    const where = () =>
      page.evaluate(
        ([scroller, lastSel]) => {
          const box = document.querySelector(scroller);
          if (!box) return null;
          // A hidden child (the sheet hides the card's more cue) has no box to show.
          const items = [...box.querySelectorAll(lastSel)].filter((el) => el.getBoundingClientRect().height);
          const last = items[items.length - 1];
          const first = [...box.children].find((el) => el.getBoundingClientRect().height);
          const at = box.getBoundingClientRect();
          const top = Math.max(at.top, 0);
          const bottom = Math.min(at.bottom, innerHeight);
          return {
            top: box.scrollTop,
            max: box.scrollHeight - box.clientHeight,
            rows: items.length,
            mid: (top + bottom) / 2,
            lastShows: Boolean(last) && last.getBoundingClientRect().bottom <= at.bottom + 1 && last.getBoundingClientRect().bottom > at.top + 40,
            firstShows: Boolean(first) && first.getBoundingClientRect().top >= at.top - 1 && first.getBoundingClientRect().top < at.bottom,
          };
        },
        [scroller, lastSel],
      );
    const swipe = async (y0, y1) => {
      const x = phone.viewport.width / 2;
      const steps = 14;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
      for (let i = 1; i <= steps; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / steps }] });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(450);
    };
    const reach = phone.viewport.height * 0.25;

    const start = await where();
    // Not vacuous: the card or list is there, holds rows, and runs past the sheet.
    if (!start || !start.rows || start.max <= 0) {
      failures.push(label);
      console.log(`FAIL ${label}: preview not set up to test (shows ${Boolean(start)}, rows ${start?.rows ?? 0}, overflow ${start?.max ?? 0}px)`);
      await context.close();
      continue;
    }
    if (shots) await page.screenshot({ path: join(shots, `feed-scroll-${label.replace(/ /g, "-")}-top.png`) });

    const maxSwipes = swipesFor(start.max, reach);
    // Up: the finger starts in the middle of what shows, as a person's does.
    let now = start;
    for (let i = 0; i < maxSwipes && !(now.lastShows && now.top >= now.max - 1); i++) {
      await swipe(now.mid + reach / 2, now.mid - reach / 2);
      now = await where();
    }
    if (shots) await page.screenshot({ path: join(shots, `feed-scroll-${label.replace(/ /g, "-")}-bottom.png`) });
    const down = now;
    // Down: back to the top.
    for (let i = 0; i < maxSwipes && !(now.firstShows && now.top <= 0); i++) {
      await swipe(now.mid - reach / 2, now.mid + reach / 2);
      now = await where();
    }
    const problems = [];
    if (!(down.lastShows && down.top >= down.max - 1)) problems.push(`swiping up stopped at ${Math.round(down.top)} of ${Math.round(down.max)}px; the foot never showed`);
    if (!(now.firstShows && now.top <= 0)) problems.push(`swiping down stopped at ${Math.round(now.top)}px; the top never showed`);
    if (problems.length) {
      failures.push(label);
      console.log(`FAIL ${label}: ${problems.join("; ")}`);
    } else console.log(`ok   ${label}: ${Math.round(down.max)}px both ways by touch`);
    await context.close();
    if (video) console.log(`     video ${await page.video().path()}`);
  }
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`feed-touch-scroll: ${failures.length} phone(s) cannot reach a whole card or Answered by touch`);
  process.exit(1);
}
console.log("feed-touch-scroll: every card and Answered row reachable by touch");
