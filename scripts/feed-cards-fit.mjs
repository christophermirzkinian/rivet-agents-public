#!/usr/bin/env node
/**
 * Fails when any card is wider than the screen: a large phone-sized viewport, a small one and the
 * desktop layout. Serves the dev preview (web/preview/desktop.html?v4=1, fake data with today's answers) with Vite
 * and opens every card in turn as the open one, so each media kind (stills, video, before/after, sound, files, a still
 * with a file) and the thread line show at full size, then Answered. A phone shows them in the Decide sheet, its head and
 * switch measured with them; the desktop in the Feed. Names each
 * element past the screen's left or right edge; a strip that scrolls sideways inside a card is measured by its own box.
 * A row is held to its own box too: a part laid out in a flex or grid box that runs past that box's inside fails, even
 * while it stays on the screen (a card's tool row was 24 px wider than its card and passed). A part pulled out
 * by its own negative margins (a card's stage, edge to edge) is where it was put, and a box that clips or scrolls
 * sideways looks after its own. A phone also opens the long ask's stills in the full-screen viewer, whose bar holds
 * the most controls (Previous, Next, Download, Share and Close): each keeps a 44 px tap size and none leaves the bar.
 * A view with no card or row in it fails, and so does a drawn still or clip that never loads: a check that measured
 * nothing must not pass. A card's long "Round 1 · ..." thread line once widened the whole list of cards past a phone.
 *   node scripts/feed-cards-fit.mjs [--shots <dir>]
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { unloaded } from "./feed-media-ready.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const at = process.argv.indexOf("--shots");
const shots = at > 0 ? process.argv[at + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

/** Cards whose drawn media must load before they are measured: a still with a file, a video and a before/after pair. */
const LOADED = ["audit-checklist-file", "intro-clip", "tap-hint-glow"];

// Exercise real video decoding at the fixture dimensions without racing a live
// canvas recorder against a busy runner's frame delivery and wall-clock timers.
const clips = Object.fromEntries([
  ["540x720", "feed-portrait.webm"],
  ["1920x1080", "feed-landscape.webm"],
].map(([size, file]) => [size, readFileSync(new URL(`./fixtures/${file}`, import.meta.url)).toString("base64")]));

const SCREENS = [
  { name: "390", viewport: { width: 390, height: 844 }, phone: true },
  { name: "320", viewport: { width: 320, height: 568 }, phone: true },
  { name: "desktop", viewport: { width: 1280, height: 800 }, phone: false },
];

/**
 * Elements of the Feed or the Decide sheet past the screen's edges, outermost first, and how many cards and rows it measured; a sideways
 * strip counts as its own box.
 */
function pastEdges() {
  const width = document.documentElement.clientWidth;
  const name = (el) => `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join("")}`;
  const cards = [...document.querySelectorAll(".feed, .desk-detail, .decide-sheet, .decide-card, [data-need], .lightbox")];
  const rows = [...document.querySelectorAll("[data-need], .ans-row")].filter((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().height).length;
  const inStrip = (el, card) => {
    for (let up = el.parentElement; up && up !== card; up = up.parentElement) if (/auto|scroll/.test(getComputedStyle(up).overflowX)) return true;
    return false;
  };
  const px = (value) => parseFloat(value) || 0;
  const past = new Set();
  const pastRow = new Map();
  for (const card of cards) {
    for (const el of [card, ...card.querySelectorAll("*")]) {
      if (el !== card && inStrip(el, card)) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (box.right > width + 0.5 || box.left < -0.5) past.add(el);
      // The part's margin box against its row's content box.
      const row = el === card ? null : el.parentElement;
      const rs = row && getComputedStyle(row);
      const cs = getComputedStyle(el);
      if (!rs || !/flex|grid/.test(rs.display) || rs.overflowX !== "visible" || /absolute|fixed/.test(cs.position)) continue;
      const outer = row.getBoundingClientRect();
      const left = outer.left + px(rs.borderLeftWidth) + px(rs.paddingLeft);
      const right = outer.right - px(rs.borderRightWidth) - px(rs.paddingRight);
      if (box.right + px(cs.marginRight) > right + 0.5 || box.left - px(cs.marginLeft) < left - 0.5) pastRow.set(el, `${name(el)} runs past its row ${name(row)} (left ${Math.round(box.left)}, right ${Math.round(box.right)}, row ${Math.round(left)} to ${Math.round(right)})`);
    }
  }
  const all = [...past];
  const named = all
    .filter((el) => !all.some((other) => other !== el && other.contains(el)))
    .slice(0, 6)
    .map((el) => {
      const box = el.getBoundingClientRect();
      return `${name(el)} (left ${Math.round(box.left)}, right ${Math.round(box.right)}, screen ${width})`;
    });
  return { rows, past: [...named, ...[...pastRow.values()].slice(0, 6)] };
}

const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  // Stills are drawn and swapped in after the card lands: their size is what can push a card out. The swaps are awaited
  // first, as a fixture's own src fails before its drawn still replaces it. A lazy still below the screen never loads on
  // its own, so each is made eager and every still is awaited until it loads or fails.
  await page.evaluate(() => window.previewMediaDrawn());
  await page.evaluate(() =>
    Promise.all(
      [...document.images].map((img) => {
        img.loading = "eager";
        return img.complete ? null : new Promise((done) => (img.addEventListener("load", done, { once: true }), img.addEventListener("error", done, { once: true }), setTimeout(done, 2000)));
      }),
    ),
  );
  // The Floor's motion waits, paused, under a tall sheet, and a repaint may cancel it: neither is a slide to wait for.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((one) => one.playState !== "paused" && one.effect?.getComputedTiming().iterations !== Infinity).map((one) => one.finished.catch(() => {}))));
};

/** Runs one view, once more if Vite reloaded the page under it (a cold dependency cache reloads once on first use). */
const view = async (run) => {
  try {
    await run();
  } catch (error) {
    if (!/context was destroyed|navigat/i.test(String(error))) throw error;
    await run();
  }
};

const server = await createServer({ root: join(root, "web"), configFile: join(root, "vite.config.ts"), logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const { local: [base] } = server.resolvedUrls;
const browser = await chromium.launch();
const failures = [];
let checked = 0;
const check = async (page, label, problems = []) => {
  const { rows, past } = await page.evaluate(pastEdges);
  checked++;
  if (!rows) past.push("no card or row measured");
  past.push(...problems);
  if (shots) await page.screenshot({ path: join(shots, `feed-cards-fit-${label.replace(/\s+/g, "-")}.png`) });
  if (past.length) {
    failures.push(label);
    console.log(`FAIL ${label}`);
    for (const line of past) console.log(`  ${line}`);
  } else console.log(`ok   ${label}`);
};
try {
  for (const screen of SCREENS) {
    const context = await browser.newContext({ viewport: screen.viewport, deviceScaleFactor: 2, isMobile: screen.phone, hasTouch: screen.phone, timezoneId: "UTC" });
    await context.addInitScript((clips) => { window.__RIVET_PREVIEW_CLIPS__ = clips; }, clips);
    const page = await context.newPage();
    // Midday: Done shows the answers given on the owner's day, and the preview's are minutes old, so near midnight
    // they would fall on yesterday.
    await page.clock.setFixedTime(new Date("2026-10-16T12:00:00Z"));
    await page.goto(`${base}preview/desktop.html?tab=cards&v4=1`);
    await page.waitForSelector("[data-need]");
    const needs = await page.evaluate(async () => (await (await fetch("/api/board")).json()).board.needs.filter((need) => need.kind !== "update"));
    for (const need of needs) {
      await view(async () => {
        await page.goto(`${base}preview/desktop.html?tab=cards&v4=1&top=${need.id}`);
        await page.waitForSelector(`${screen.phone ? ".decide-sheet .decide-card " : ""}[data-need="${need.id}"]`);
        const missing = LOADED.includes(need.id) ? await page.evaluate(unloaded, need.id) : [];
        await settle(page);
        const kinds = need.media ? [need.media.kind, ...(need.media.files && need.media.kind !== "files" ? ["files"] : [])] : [];
        await check(page, `${screen.name} ${need.id}${kinds.length ? ` (${kinds.join(" + ")})` : ""}`, missing.map((what) => `${what} did not load`));
      });
    }
    if (screen.phone) {
      // A long ask, five stills and four answers (?longask=1): the card scrolls as one piece, its answers in its flow,
      // and none of its parts scrolls on its own.
      await view(async () => {
        const id = "long-ask-five-stills";
        await page.goto(`${base}preview/desktop.html?tab=cards&v4=1&longask=1&top=${id}`);
        await page.waitForSelector(`.decide-sheet .decide-card [data-need="${id}"]`);
        await settle(page);
        const problems = await page.evaluate((id) => {
          const card = document.querySelector(`.decide-sheet .decide-card [data-need="${id}"]`);
          const answers = card.querySelector(".choices");
          const out = [];
          if (!answers || answers.querySelectorAll(":scope > button").length !== 4) return ["the long-ask card has no 4 answers"];
          if (getComputedStyle(answers).position === "sticky") out.push("4 answers pinned");
          for (const el of card.querySelectorAll("*")) {
            const cs = getComputedStyle(el);
            if (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) out.push(`${el.className} scrolls inside the card`);
          }
          card.scrollTop = card.scrollHeight;
          const last = answers.lastElementChild.getBoundingClientRect();
          const box = card.getBoundingClientRect();
          if (last.bottom > box.bottom + 1 || last.top < box.top) out.push("the last answer is not in sight at the card's end");
          return out;
        }, id);
        await check(page, `${screen.name} long ask`, problems);
        // The same card's stills in the full-screen viewer, opened by the still or thumb that shows.
        await page.locator(`.decide-sheet [data-need="${id}"] :is(.card-thumb, .media-still)`).filter({ visible: true }).first().click();
        await page.waitForSelector(".lightbox-bar .lightbox-close");
        await settle(page);
        // The bar as it stands: its problems, and the title's font size to prove a text size took.
        const bar = () => page.evaluate(() => {
          const controls = [...document.querySelectorAll(".lightbox-bar button")].filter((el) => el.getBoundingClientRect().width);
          const out = controls.filter((el) => el.getBoundingClientRect().width < 43.5 || el.getBoundingClientRect().height < 43.5).map((el) => `${el.getAttribute("aria-label") ?? el.textContent} is under the 44 px tap size`);
          if (controls.length !== 5) out.push(`the viewer's bar has ${controls.length} controls, not Previous, Next, Download, Share and Close`);
          const title = document.querySelector(".lightbox-bar .lightbox-title");
          return { out, font: title ? parseFloat(getComputedStyle(title).fontSize) : 0 };
        });
        const medium = await bar();
        await check(page, `${screen.name} viewer`, medium.out);
        // Once more at the Large text size, which widens every word in the bar.
        await page.evaluate(() => document.documentElement.setAttribute("data-chat-text", "l"));
        await settle(page);
        const large = await bar();
        if (!(large.font > medium.font * 1.1)) large.out.push(`Large text did not take: the title is ${large.font} px, ${medium.font} px before`);
        await check(page, `${screen.name} viewer, large text`, large.out);
      });
      await view(async () => {
        await page.goto(`${base}preview/desktop.html?tab=cards&v4=1`);
        // A phone's Answered N is in the card's ⋯ menu.
        await page.click(".decide-sheet .decide-more");
        await page.click('.decide-menu .decide-seg[data-seg="answered"]');
        await page.waitForSelector(".decide-sheet .decide-card.is-list .ans-row");
        await settle(page);
        await check(page, `${screen.name} answered`);
      });
    }
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (checked < 20) {
  console.log(`feed-cards-fit: only ${checked} views checked; the preview's cards did not load`);
  process.exit(1);
}
if (failures.length) {
  console.log(`feed-cards-fit: ${failures.length} view(s) failed layout or media checks (see details above)`);
  process.exit(1);
}
console.log(`feed-cards-fit: every card fits the screen (${checked} views)`);
