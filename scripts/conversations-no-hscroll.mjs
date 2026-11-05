#!/usr/bin/env node
/**
 * Fails when the Chat tab's conversations scroll sideways on a large phone (412x915). Serves the dev preview (web/preview/desktop.html, fake data) with Vite and measures the
 * page and every panel in it, naming the elements past the right edge of each one that scrolls. Then Feed, Desks and Chat
 * with Claude's usage read, at 412 and 360: the header, view and tab bar each end inside the screen (a header chip can widen the
 * whole page while the page itself, overflow hidden, never scrolls).
 *   node scripts/conversations-no-hscroll.mjs [--shots <dir>]
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const HEADER_PHONES = [412, 360];
const HEADER_TABS = ["cards", "progress", "chat", "more"];
const PHONES = [
  { name: "412", viewport: { width: 412, height: 915 } },
];
/**
 * The conversation with Rivet, a new draft, and things' pages: one with chips and a card answer, an
 * app-only one, and one holding its cards inline. `hold` is a row held before `click`, which is one selector or a list.
 */
const VIEWS = [
  { name: "rivet", query: "", ready: ".chat-msg" },
  { name: "new", query: "&new=1", ready: ".chat-msg" },
  { name: "conversation-k1", query: "&conversation=k1", ready: '.chat-msg[data-id="k3"]' },
  { name: "conversation-w1", query: "&conversation=w1", ready: '.chat-msg[data-id="w2"]' },
  { name: "conversation-lp1", query: "&conversation=lp1", ready: '.chat-msg[data-id="lp5"] .chat-posted-open' },
];

const server = await createServer({ root: join(root, "web"), configFile: join(root, "vite.config.ts"), logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const { local: [base] } = server.resolvedUrls;
const browser = await chromium.launch();
const failures = [];
try {
  for (const phone of PHONES) {
    for (const view of VIEWS) {
      const page = await browser.newPage({ viewport: phone.viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.goto(`${base}preview/desktop.html?tab=chat${view.query}`);
      await page.waitForSelector(view.ready);
      if (view.hold) {
        await page.locator(view.hold).scrollIntoViewIfNeeded();
        const box = await page.locator(view.hold).boundingBox();
        await page.mouse.move(box.x + 40, box.y + 20);
        await page.mouse.down();
        await page.waitForTimeout(650);
        await page.mouse.up();
        if (!view.click) await page.waitForSelector(view.after);
      }
      if (view.click) {
        for (const selector of [view.click].flat()) await page.click(selector);
        await page.waitForSelector(view.after);
      }
      await page.evaluate(() => document.fonts.ready);
      // A sheet slides in: the still waits for it to land.
      // The Floor's motion waits, paused, under a tall sheet, and a repaint may cancel it: neither is a slide to wait for.
      await page.evaluate(() => Promise.all(document.getAnimations().filter((one) => one.playState !== "paused" && one.effect?.getComputedTiming().iterations !== Infinity).map((one) => one.finished.catch(() => {}))));
      const scrolling = await page.evaluate(() => {
        const name = (el) => `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join("")}`;
        const doc = document.documentElement;
        return [doc, ...document.body.querySelectorAll("*")]
          .filter((el) => el === doc || /auto|scroll/.test(getComputedStyle(el).overflowX))
          .filter((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth)
          .map((el) => {
            const edge = el === doc ? el.clientWidth : el.getBoundingClientRect().left + el.clientLeft + el.clientWidth;
            const past = [...el.querySelectorAll("*")].filter((kid) => kid.getBoundingClientRect().right > edge + 0.5);
            const outermost = past.filter((kid) => !past.some((other) => other !== kid && other.contains(kid))).slice(0, 6);
            const named = outermost.map((kid) => `${name(kid)} (right ${Math.round(kid.getBoundingClientRect().right)} > ${Math.round(edge)})`);
            return `${name(el)} scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}; past its edge: ${named.join(", ")}`;
          });
      });
      const label = `${phone.name} ${view.name}`;
      if (shots) {
        // As a sideways swipe leaves it: each panel scrolled as far right as it goes.
        await page.evaluate(() => document.querySelectorAll(".chat-scroll").forEach((el) => (el.scrollLeft = el.scrollWidth)));
        await page.screenshot({ path: join(shots, `conversations-${phone.name}-${view.name}.png`) });
      }
      if (scrolling.length) {
        failures.push(label);
        console.log(`FAIL ${label}`);
        for (const line of scrolling) console.log(`  ${line}`);
      } else console.log(`ok   ${label}`);
      await page.close();
    }
  }
  for (const width of HEADER_PHONES) {
    for (const tab of HEADER_TABS) {
      const page = await browser.newPage({ viewport: { width, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.goto(`${base}preview/desktop.html?tab=${tab}&chip=1`);
      await page.waitForSelector(".topbar > *", { state: "attached" });
      await page.evaluate(() => document.fonts.ready);
      const past = await page.evaluate(() => {
        const name = (el) => `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join("")}`;
        const app = document.querySelector(".app");
        return [...app.children, ...document.querySelectorAll(".topbar *")]
          .filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5)
          .map((el) => `${name(el)} (right ${Math.round(el.getBoundingClientRect().right)} > ${innerWidth})`);
      });
      const label = `${width} ${tab} header`;
      if (shots) await page.screenshot({ path: join(shots, `header-${width}-${tab}.png`) });
      if (past.length) {
        failures.push(label);
        console.log(`FAIL ${label}: past the screen's right edge: ${past.slice(0, 6).join(", ")}`);
      } else console.log(`ok   ${label}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`conversations-no-hscroll: ${failures.length} view(s) scroll sideways`);
  process.exit(1);
}
console.log("conversations-no-hscroll: no sideways scroll");
