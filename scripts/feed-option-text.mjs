#!/usr/bin/env node
/**
 * Fails when a decision button on the Feed hides any of its text: a large phone-sized viewport, a small one and the
 * desktop layout. Serves the dev preview (web/preview/desktop.html, fake data) with Vite and opens
 * the "open-sign-up" card, whose three shorts are the card format's 40 characters, then again with ?long=1: a
 * 200-character label with no short (the desktop's bar then points to the card's own list, which must show it whole),
 * and an unbroken 40-character short. On the desktop one set of answers shows, never two: with short answers the bar's picks are the set and the card lists none. A phone's answers are the card's own boxes, with no row under it. A two-line clamp cut "Ship it: invited…"
 * mid-sentence on a phone.
 *   node scripts/feed-option-text.mjs [--shots <dir>]
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const at = process.argv.indexOf("--shots");
const shots = at > 0 ? process.argv[at + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const SCREENS = [
  { name: "390", viewport: { width: 390, height: 844 }, phone: true },
  { name: "320", viewport: { width: 320, height: 568 }, phone: true },
  { name: "desktop", viewport: { width: 1280, height: 800 }, phone: false },
];
const CARD = "open-sign-up";

const server = await createServer({ root: join(root, "web"), configFile: join(root, "vite.config.ts"), logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const { local: [base] } = server.resolvedUrls;
const browser = await chromium.launch();
const failures = [];
try {
  for (const screen of SCREENS) {
    for (const long of [false, true]) {
      const label = `${screen.name}${long ? " long" : ""}`;
      const context = await browser.newContext({ viewport: screen.viewport, deviceScaleFactor: 2, isMobile: screen.phone, hasTouch: screen.phone });
      const page = await context.newPage();
      // A phone shows risky cards first: the preview's one risky card (sign-in-retry, index 5 once ?top= moves this card
      // to the front; the preview's revs are the index, 16 times) is put as Later.
      await page.addInitScript(() => localStorage.setItem("rivet.later", JSON.stringify([["sign-in-retry", "5".repeat(16)]])));
      await page.goto(`${base}preview/desktop.html?tab=cards&top=${CARD}${long ? "&long=1" : ""}`);
      const bar = `:is(.actions, .desk-actions)[data-need="${CARD}"]`;
      // A phone's answers are the card's own boxes, with no row of them under the card.
      await page.waitForSelector(screen.phone ? `.card.top[data-need="${CARD}"] .btn.choice` : `${bar} .btn.pick`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);
      const result = await page.evaluate(
        ({ bar, card, long, phone }) => {
          const problems = [];
          const picks = [...document.querySelectorAll(`${bar} .btn.pick`)];
          const choices = [...document.querySelectorAll(`.card.top[data-need="${card}"] .btn.choice`)];
          /** Text nodes inside `element` that show something. */
          const texts = (element) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            const found = [];
            while (walker.nextNode()) if (walker.currentNode.textContent.trim()) found.push(walker.currentNode);
            return found;
          };
          /** Whether the button's text sits inside its padding box: past it the border, or overflow hidden, cuts it. */
          const check = (button, kind, vertical) => {
            const name = `${kind} "${button.getAttribute("aria-label") ?? button.textContent.slice(0, 24)}"`;
            const box = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            const inner = {
              left: box.left + parseFloat(style.borderLeftWidth),
              right: box.right - parseFloat(style.borderRightWidth),
              top: box.top + parseFloat(style.borderTopWidth),
              bottom: box.bottom - parseFloat(style.borderBottomWidth),
            };
            for (const node of texts(button)) {
              const range = document.createRange();
              range.selectNodeContents(node);
              const text = range.getBoundingClientRect();
              const outside = text.left < inner.left - 0.5 || text.right > inner.right + 0.5 || (vertical && (text.top < inner.top - 0.5 || text.bottom > inner.bottom + 0.5));
              if (outside) problems.push(`${name}: text ${Math.round(text.left)}..${Math.round(text.right)} x ${Math.round(text.top)}..${Math.round(text.bottom)} outside the button ${Math.round(inner.left)}..${Math.round(inner.right)} x ${Math.round(inner.top)}..${Math.round(inner.bottom)}`);
            }
            if (button.scrollWidth > button.clientWidth + 1 || (vertical && button.scrollHeight > button.clientHeight + 1)) problems.push(`${name}: overflows its box`);
            for (const element of [button, ...button.querySelectorAll("*")]) {
              const own = getComputedStyle(element);
              if (own.textOverflow === "ellipsis" || own.webkitLineClamp !== "none") problems.push(`${name}: ${element.className || element.tagName} ends in an ellipsis`);
            }
          };
          for (const pick of picks) {
            check(pick, "button", true);
            // The size of the text itself, not the button around it (the desktop's label is a span).
            for (const node of texts(pick)) {
              if (node.parentElement.closest("kbd")) continue;
              const size = parseFloat(getComputedStyle(node.parentElement).fontSize);
              if (size < 15) problems.push(`button "${pick.getAttribute("aria-label")}": ${size}px text`);
            }
          }
          // The card's own list of answers: the whole text across, under the card's own scroll.
          for (const choice of choices) {
            check(choice, "card answer", false);
            // The answer's label at body size at least; the Recommended badge and detail are captions.
            for (const part of choice.querySelectorAll(".choice-label")) {
              const size = parseFloat(getComputedStyle(part).fontSize);
              if (size < 14) problems.push(`card answer "${part.textContent.slice(0, 24)}": ${size}px text`);
            }
          }
          const heights = picks.map((pick) => Math.round(pick.getBoundingClientRect().height));
          if (new Set(heights).size > 1) problems.push(`the row's buttons differ in height: ${heights.join(", ")}`);
          const row = picks[0]?.parentElement;
          const rowBox = row?.getBoundingClientRect();
          if (rowBox && (rowBox.bottom > innerHeight || rowBox.top < 0)) problems.push(`the row is off screen (${Math.round(rowBox.top)}..${Math.round(rowBox.bottom)} of ${innerHeight})`);
          const top = document.querySelector(`.card.top[data-need="${card}"]`)?.getBoundingClientRect().height ?? 0;
          if (phone && top < 160) problems.push(`the card shrank to ${Math.round(top)}px`);
          // The desktop's short answers are the bar's picks alone; a phone, and the desktop's long ones, list them in the card.
          const listed = phone || long ? 3 : 0;
          if (choices.length !== listed) problems.push(`expected ${listed} answers on the card, found ${choices.length}`);
          return { count: picks.length, answers: choices.length, heights, problems, names: picks.map((pick) => pick.textContent.trim()) };
        },
        { bar, card: CARD, long, phone: screen.phone },
      );
      // A label past a short's 40 characters would wrap the bar past the card: one button points to the card's
      // own list instead, and a tap on it brings that list into view.
      const pointer = long && !screen.phone;
      if (pointer) {
        if (result.count !== 1 || result.names[0] !== "Pick an answer ↑") result.problems.unshift(`expected one "Pick an answer ↑" button, found ${JSON.stringify(result.names)}`);
        else {
          await page.locator(`${bar} .btn.pick`).click();
          await page.waitForTimeout(800);
          const shows = await page.evaluate((card) => {
            const element = document.querySelector(`.card.top[data-need="${card}"] .card-body`);
            const body = element.getBoundingClientRect();
            const list = document.querySelector(`.card.top[data-need="${card}"] .choices`).getBoundingClientRect();
            // The list's top at the body's top, or as near as the body scrolls (a short card cannot scroll it all the way).
            const end = element.scrollTop >= element.scrollHeight - element.clientHeight - 1;
            return list.top >= body.top - 1 && (list.top < body.top + 40 || (end && list.top < body.bottom - 60));
          }, CARD);
          if (!shows) result.problems.push("a tap on Pick an answer did not bring the card's answers into view");
          if (shots) await page.screenshot({ path: join(shots, `feed-option-text-${screen.name}-long-tapped.png`) });
        }
      } else if (screen.phone) {
        if (result.count !== 0) result.problems.unshift(`expected no answer row under the card (its boxes are the answers), found ${result.count}`);
      } else if (result.count !== 3) result.problems.unshift(`expected 3 option buttons, found ${result.count}`);
      if (shots) {
        const name = `feed-option-text-${screen.name}${long ? "-long" : ""}`;
        await page.screenshot({ path: join(shots, `${name}.png`) });
        await page.locator(bar).screenshot({ path: join(shots, `${name}-bar.png`) });
      }
      if (result.problems.length) {
        failures.push(label);
        console.log(`FAIL ${label}: ${result.problems.join("; ")}`);
      } else if (screen.phone) console.log(`ok   ${label}: the card's ${result.answers} answer boxes show their whole text`);
      else console.log(`ok   ${label}: ${result.count} buttons show their whole text (${result.heights[0]}px tall)`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`feed-option-text: ${failures.length} screen(s) hide option text`);
  process.exit(1);
}
console.log("feed-option-text: every option button shows its whole text");
