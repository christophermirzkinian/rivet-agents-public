import "./progress.css";
import "./floor.css";

import { TEAM_ROOM_ID, TEAM_ROOM_TITLE } from "../../../src/shared/conversations.js";
import { RIVET_NAME } from "../../../src/shared/names.js";
import { when } from "../../../src/shared/when.js";
import { isDesk } from "../desk.js";
import { h, keepFocus } from "../dom.js";
import { opsData, watchOps } from "../ops-data.js";
import { app, boardRead, setOpsPage, subscribe } from "../state.js";
import { askingCards } from "./decide-sheet.js";
import { mountDesks } from "./desks.js";
import * as feed from "./feed.js";
import { goSheet } from "./home.js";
import * as ops from "./ops.js";
import { parked } from "./ops-status.js";
import { holdStatusLine, onStatusPaint, releaseStatusLine } from "./status-line.js";
import { closeWorkerSheet } from "./worker-sheet.js";
import * as asks from "./your-asks.js";

// The Floor, a page in the menu: the desks, then Plan. The phone's band (shell.ts) holds the one line under its title,
// made and painted here.

let stop: (() => void) | null = null;

/** The desks at their natural height, the page scrolling them and Plan under them. */
function mountStage(): { el: HTMLElement; stop: () => void } {
  const desks = mountDesks();
  const el = h("section", { class: "floor-stage", attrs: { "aria-label": "Desks" } }, desks.el);
  let desk = isDesk();
  const paint = () => {
    desk = isDesk();
    desks.paint();
  };
  // The status line repaints on every board change and Ops read, so the desks follow it alone: a board subscription
  // too would paint them twice a poll.
  holdStatusLine();
  const unpaint = onStatusPaint(paint);
  paint();
  const onResize = () => isDesk() !== desk && paint();
  window.addEventListener("resize", onResize);
  return {
    el,
    stop() {
      unpaint();
      releaseStatusLine();
      window.removeEventListener("resize", onResize);
      desks.stop();
    },
  };
}

export function mount(el: HTMLElement): void {
  unmount();
  const stage = mountStage();
  const plan = h("div", { class: "progress-plan" });
  const room = h(
    "button",
    { class: "floor-room", attrs: { type: "button", "data-use": "floor.team-room" }, on: { click: () => feed.openConversation(TEAM_ROOM_ID) } },
    TEAM_ROOM_TITLE,
    h("span", { class: "floor-line-more", attrs: { "aria-hidden": "true" } }, "›"),
  );
  el.replaceChildren(h("div", { class: "progress floor" }, h("div", { class: "progress-scene" }, stage.el), room, plan));
  setOpsPage("plan");
  ops.mount(plan);
  stop = stage.stop;
}

export function refresh(): Promise<unknown> {
  return Promise.all([asks.refresh(), ops.refresh(), feed.refresh()]);
}

export function unmount(): void {
  if (!stop) return;
  closeWorkerSheet("floor");
  ops.unmount();
  stop();
  stop = null;
}

let lineEl: HTMLElement | null = null;

/** The band's one line under the title, only while something is for you; it opens and closes rather than jumping. */
export function line(): HTMLElement {
  lineEl ??= h("div", { class: "floor-line", attrs: { inert: "", "aria-hidden": "true" } }, h("div", { class: "floor-line-fold" }));
  return lineEl;
}

/** Keeps the line current until the returned stop. */
export function watchLine(): () => void {
  const paint = () => paintLine(line());
  const stops = [subscribe(paint), watchOps(paint), asks.watchAsks(paint)];
  paint();
  return () => {
    for (const one of stops) one();
  };
}

const HOUR_MS = 60 * 60 * 1000;

export interface Said {
  key: "offline" | "cards" | "due" | "machine" | "usage";
  tone: "cards" | "due" | "warn" | "bad";
  /** The part never cut: the time of a job due. */
  lead: string | null;
  text: string;
  label: string;
  open: (() => void) | null;
}

/** The line's pills: the one thing `said` names, then the alerts. */
function lineParts(now: number): Said[] {
  return [said(now), ...alerts()].filter((part) => part !== null);
}

/** A read that failed after the cards loaded: the phone's line and the wide header show it. */
export function alerts(): Said[] {
  if (app.loadedAt === null || boardRead() !== "loaded" || !(app.offline || app.notice)) return [];
  const text = `${app.offline === "offline" ? "Offline" : `Can't reach ${RIVET_NAME}`} · cards as of ${when(app.loadedAt)}`;
  return [{ key: "offline", tone: "warn", lead: null, text, label: text, open: null }];
}

/** The one thing the line says, the first of: cards waiting, a job due within the hour, a machine amber or red, Usage near its cap. */
function said(now: number): Said | null {
  const n = askingCards().length;
  if (n)
    return {
      key: "cards",
      tone: "cards",
      lead: null,
      text: `${n} ${n === 1 ? "card waits" : "cards wait"} for you`,
      label: `${n} ${n === 1 ? "card waits" : "cards wait"} for you, open Decide`,
      open: () => {
        feed.pickSegment("needs");
        goSheet("cards");
      },
    };
  const job = asks.dueSoon(now, HOUR_MS);
  if (job) {
    const time = job.time.charAt(0).toUpperCase() + job.time.slice(1);
    return { key: "due", tone: "due", lead: time, text: job.title, label: `${time}: ${job.title}`, open: job.open };
  }
  // Machines only: a phone with notifications off is a Machines row too, but no machine, and Settings mends it. A
  // fault you parked stays calm here as on Plan (ops-status.ts parked).
  const wrong = ops.wrongRows(opsData.ops, "machines");
  const rows = wrong.rows.filter((row) => row.kind !== "push" && !parked(row.item));
  // Every machine counts, not just the rows shown.
  const total = wrong.count - (wrong.rows.length - rows.length);
  const first = rows[0];
  if (first) {
    const text = `${first.title} needs a look${total > 1 ? ` · ${total - 1} more` : ""}`;
    return { key: "machine", tone: first.tone, lead: null, text, label: `${text}, open Machines`, open: () => goSheet("machines") };
  }
  // An old reading is the notices' to say: near the cap is said only of a current one.
  const claude = opsData.ops?.claude ?? null;
  const week = claude && !ops.usageStale(claude) ? ops.weekTotal(claude.limits) : null;
  if (week && week.tone !== "ok")
    return { key: "usage", tone: week.tone, lead: null, text: `Usage ${week.n} ${week.of} · near the cap`, label: `Usage, Claude ${week.text}, open Usage`, open: () => goSheet("usage") };
  return null;
}

/** Shows the line's pills, or folds it away with their words kept so it fades out as it was. */
function paintLine(el: HTMLElement): void {
  const all = lineParts(Date.now());
  const on = all.length > 0;
  el.classList.toggle("is-on", on);
  el.toggleAttribute("inert", !on);
  if (on) el.removeAttribute("aria-hidden");
  else el.setAttribute("aria-hidden", "true");
  if (!on) return;
  const fold = el.firstElementChild as HTMLElement;
  const refocus = keepFocus(fold);
  fold.replaceChildren(...all.map(pill));
  refocus();
}

function pill(now: Said): HTMLElement {
  const parts = [
    h("span", { class: "floor-line-dot", attrs: { "aria-hidden": "true" } }),
    now.lead ? h("span", { class: "floor-line-lead" }, now.lead, " ·") : null,
    h("span", { class: "floor-line-text" }, now.text),
    now.open ? h("span", { class: "floor-line-more", attrs: { "aria-hidden": "true" } }, "›") : null,
  ];
  const cls = `floor-line-say t-${now.tone}`;
  return now.open
    ? h("button", { class: cls, attrs: { type: "button", "data-key": `line-${now.key}`, "data-use": `floor.line.${now.key}`, "aria-label": now.label }, on: { click: now.open } }, ...parts)
    : h("p", { class: cls, attrs: { "data-key": `line-${now.key}`, "aria-label": now.label } }, ...parts);
}
