// Real Chromium history and two-tab draft regressions, using the login-free Vite preview.
// Set PORT for the preview, or CHAT_QA_URL for one already running; WORKER_OUT is where its files go.
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const base = process.env.CHAT_QA_URL || `http://127.0.0.1:${process.env.PORT || 5230}`;
const out = process.env.WORKER_OUT || "output/rivet-chat-state";
mkdirSync(out, { recursive: true });
const results = {};

async function open(query) {
  await page.goto(`${base}/preview/desktop.html?tab=chat${query}`);
  await page.locator(".chat-text").waitFor();
}
async function viewer() {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 400;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#173c38";
    ctx.fillRect(0, 0, 600, 400);
    ctx.fillStyle = "#ffffff";
    ctx.font = "32px sans-serif";
    ctx.fillText("Chat attachment", 140, 210);
    const { openImages } = await import("/src/views/lightbox.ts");
    openImages([canvas.toDataURL()], 0, "Chat attachment");
  });
  await page.locator(".lightbox").waitFor();
}
async function capture(name) {
  await page.waitForTimeout(300);
  results[name] = await page.evaluate(() => ({
    title: document.querySelector(".conv-head-title")?.textContent,
    draft: document.querySelector(".chat-text")?.value,
    history: history.state,
  }));
  await page.screenshot({ path: join(out, `${name}.png`) });
}
async function hold() {
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).includes("/api/chat") && init?.method === "POST")
        await new Promise(resolve => { window.releaseChat = resolve; });
      return fetch(input, init);
    };
  });
}
async function release() {
  await page.waitForFunction(() => typeof window.releaseChat === "function");
  await page.evaluate(() => window.releaseChat());
  await page.waitForTimeout(500);
}

try {
  await open("&conversation=c1");
  await viewer();
  await page.evaluate(() => history.back());
  await page.locator(".lightbox").waitFor({ state: "detached" });
  await capture("direct-link-after-back");
  assert.equal(await page.locator(".chat-text").isVisible(), true, "Viewer Back must keep direct-linked Chat open");

  await page.goto(`${base}/preview/desktop.html?tab=chat`);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.locator(".chat-text").waitFor();
  await hold();
  await page.locator(".chat-text").fill("Keep this conversation");
  await page.locator(".chat-send").click();
  await viewer();
  await release();
  await page.evaluate(() => history.back());
  await page.locator(".lightbox").waitFor({ state: "detached" });
  await capture("first-send-after-back");
  assert.equal(results["first-send-after-back"].history?.chatScreen, "c-1", "First send must resolve its covered history entry");
  assert.equal(results["first-send-after-back"].title, "Keep this conversation");

  await open("&conversation=c1");
  await hold();
  await page.locator(".chat-text").fill("ok");
  await page.locator(".chat-send").click();
  await page.locator('.tabs [data-key="cards"]').click();
  const tab = await context.newPage();
  await tab.goto(`${base}/preview/desktop.html?tab=chat&conversation=c1`);
  await tab.locator(".chat-text").waitFor();
  await tab.locator(".chat-text").fill("ok");
  await page.locator('.tabs [data-key="chat"]').click();
  await page.locator(".chat-text").waitFor();
  await page.locator(".chat-text").fill("ok ");
  await release();
  await capture("adopted-draft-after-send");
  assert.equal(await page.locator(".chat-text").inputValue(), "ok ", "Pending send must keep another tab’s adopted draft");
  console.log("PASS: direct-link Back, covered first send, adopted draft (phone-sized viewport)");
} finally {
  writeFileSync(join(out, "states.json"), JSON.stringify(results, null, 2));
  await browser.close();
}
