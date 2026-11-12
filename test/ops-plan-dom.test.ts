// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTHING_NEEDS_YOU } from "../src/shared/words.js";

import type { OpsResponse } from "../src/shared/ops.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import { opsStatusKey } from "../src/shared/ops-status-key.js";
import { opsData } from "../web/src/ops-data.js";
import { app } from "../web/src/state.js";
import { rivetMood } from "../web/src/views/desks.js";
import { failedItems } from "../web/src/views/ops.js";
import { clearWords, navMark, opsStatus } from "../web/src/views/progress-mark.js";
import * as ops from "../web/src/views/ops.js";
import { fixedToday, nextBody, ownRows, planState, prRef } from "../web/src/views/ops-plan.js";
import { statusParts } from "../web/src/views/status-line.js";
import { onShowThing } from "../web/src/views/thing.js";
import * as asks from "../web/src/views/your-asks.js";
import { serveSummary } from "./summary-served.js";

// Ops opens on Plan: what is being done, by when and why. Nothing on it, in the menu or in Rivet's mood is red; a late
// record is an amber row in Your asks, Rivet's own.

const NOW = "2026-10-20T05:00:00.000Z";
const REPO = "example-org/example-repo";
const up = { state: "up", status: 200, ms: 80, checkedAt: NOW, since: NOW, fails: 0 };
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

const redPr = (draft = false) => ({ number: 5995, title: "Login fix", repo: REPO, url: `https://github.com/${REPO}/pull/5995`, branch: "fix", draft, headAt: hoursAgo(2), updatedAt: hoursAgo(2), checks: { state: "fail", failed: 1, failing: ["CI complete"] } });

function fixture(extra: Partial<Record<string, unknown>> = {}): OpsResponse {
  return {
    now: NOW,
    healthStaleSince: null,
    bridge: { connected: true },
    github: { at: NOW, stale: false, prsComplete: true, prs: [], runs: [] },
    mac: { at: NOW, stale: false, volumes: [], load: { one: 1, five: 1, fifteen: 1, cpus: 8 }, memory: { freePct: 40, pressure: "normal" }, uptimeSec: 3600, runners: [], chatRunner: true },
    claude: { at: NOW, stale: false, limits: [] },
    flyAt: NOW,
    flyStale: false,
    flySource: null,
    summary: { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 0, disk: { freePct: 41, tone: "ok" } },
    apps: [{ id: "app", name: "App", app: "example-app", health: up, fly: { version: 1, machines: { started: 1, total: 1 }, checks: { passing: 1, total: 1 }, status: "deployed", lastRelease: { status: "complete", version: 1, at: NOW } } }],
    ...extra,
  } as unknown as OpsResponse;
}

/** A red PR, an app down and a full disk, with nobody on any of them yet. */
const broken = () =>
  fixture({
    github: { at: NOW, stale: false, prsComplete: true, prs: [redPr()], runs: [] },
    apps: [{ ...(fixture().apps![0] as object), health: { ...up, state: "down" } }],
    summary: { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 1, disk: { freePct: 2, tone: "bad" } },
  });

const prRecord = (extra: Partial<OpsStatus> & Record<string, unknown> = {}): OpsStatus =>
  ({ kind: "pr", key: opsStatusKey("pr", "5995", REPO), state: "in-progress", chat: "parser-fix", since: hoursAgo(1), updatedAt: hoursAgo(0.5), version: 1, ...extra }) as OpsStatus;

let root: HTMLElement;

const setComing = (coming: Record<string, unknown>[]) => {
  const board = { updatedAt: NOW, needs: [], chats: [], coming, shipped: [] };
  app.board = { version: 1, updatedAt: NOW, board } as never;
};

const show = (served: OpsResponse | null, statuses: OpsStatus[] | null = null) => {
  opsData.ops = served;
  opsData.statuses = statuses;
  opsData.opsAt = { mono: performance.now(), wall: Date.now() };
  // The mark reads the summary GET /api/summary makes of these records.
  serveSummary();
};

const mountPlan = () => {
  app.opsPage = "plan";
  ops.mount(root);
  return root.querySelector<HTMLElement>(".plan")!;
};

/** Progress › Your asks beside Plan, Rivet's own unfolded: Being done's Ops rows live there. */
const mountOwn = () => {
  // Beside Plan's host, not in it: a Plan redraw replaces everything in its host.
  const el = document.createElement("div");
  document.body.append(el);
  asks.mount(el);
  const fold = el.querySelector<HTMLButtonElement>('.plan-fold[data-fold="own"]');
  if (fold?.getAttribute("aria-expanded") === "false") fold.click();
  return el;
};

/** The 5995 record's row in Rivet's own. */
const ownRow = () => mountOwn().querySelector<HTMLElement>(`.ask-row[data-ask="pr/${opsStatusKey("pr", "5995", REPO)}"]`)!;
const ownWhen = () => ownRow().querySelector(".ask-when")!.textContent;

/** The rail's Ops badge as drawn: none, or an amber or red "!". */
const badge = () => {
  const el = navMark(opsStatus().mark);
  return el ? `${el.className}:${el.textContent}` : null;
};

/** Every element on the page whose class says red. */
const reds = (el: ParentNode) => [...el.querySelectorAll<HTMLElement>("[class]")].filter((one) => /\b(bad|red|no)\b/.test(one.className));

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  root = document.createElement("div");
  document.body.replaceChildren(root);
  app.tab = "progress";
  // All clear is said only once the board has loaded.
  setComing([]);
});

afterEach(() => {
  asks.unmount();
  ops.unmount();
  app.board = null;
  opsData.error = null;
  show(null);
  opsData.opsAt = { mono: 0, wall: 0 };
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("Plan", () => {
  it("is what Ops opens on, with no date line, lede, counts, Next or Refresh: Progress keeps only the asks", () => {
    show(fixture({ next: [{ key: "a", title: "Night sign-offs", at: "2026-10-20T12:00:00.000Z" }] }));
    ops.openOps();
    expect(app.opsPage).toBe("plan");
    const plan = mountPlan();
    expect(plan.querySelector(".plan-date")).toBeNull();
    expect(plan.querySelector('[data-plan-group="next"]')).toBeNull();
    expect(root.querySelector(".ops-refresh")).toBeNull();
    expect(plan.querySelector(".plan-lede")).toBeNull();
    expect(root.querySelector(".ops-pills")).toBeNull();
  });

  it("has nothing red anywhere for breaks nobody is on yet: Rivet's own, with no time yet", () => {
    show(broken());
    const plan = mountPlan();
    const own = mountOwn();
    expect(reds(document.body)).toEqual([]);
    expect(plan.querySelector('[data-plan-group="late"]')).toBeNull();
    expect(plan.querySelector('[data-plan-group="doing"]')).toBeNull();
    const rows = [...own.querySelectorAll<HTMLElement>(".ask-row")];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.querySelector(".ask-when")!.textContent).toBe("No time yet");
      expect(row.querySelector(".ask-sub")!.textContent).not.toBe("");
    }
    expect(badge()).toBeNull();
    expect(clearWords()).toMatchObject({ mood: "happy", title: NOTHING_NEEDS_YOU });
    expect(rivetMood()).toBe("happy");
    expect(statusParts().map((part) => part.tone)).not.toContain("bad");
    expect(root.textContent).not.toMatch(/Something broke|Fix it|Wrong now|Not picked up/);
    // The finder does see red.
    const control = document.createElement("div");
    control.innerHTML = `<span class="badge t-bad"></span>`;
    expect(reds(control)).toHaveLength(1);
  });

  it("says done by when a record has a dueAt, with its why in Plan's words", () => {
    show(broken(), [prRecord({ dueAt: "2026-10-20T06:30:00.000Z", why: "Rerunning CI after the flaky lobby test was fixed" })]);
    mountPlan();
    const row = [...mountOwn().querySelectorAll<HTMLElement>(".ask-row")].find((one) => one.textContent!.includes("Login fix"))!;
    expect(row.querySelector(".ask-when")!.textContent).toBe("by 5:30pm");
    expect(row.querySelector(".ask-sub")!.textContent).toBe("Rerunning tests after the flaky lobby test was fixed");
    // The calm line is the asks in hand: none here.
    expect(opsStatus().mark).toMatchObject({ dot: null, owned: null });
  });

  it("makes a record late once its dueAt has passed: an amber row in Rivet's own with no time yet", () => {
    show(broken(), [prRecord({ dueAt: hoursAgo(0.5), why: "CI ran out of disk" })]);
    mountPlan();
    const row = ownRow();
    expect(row.classList.contains("is-counted")).toBe(true);
    expect(row.querySelector(".ask-when")!.textContent).toBe("No time yet");
    expect(row.querySelector(".ask-sub")!.textContent).toBe("tests ran out of disk");
    expect(reds(document.body)).toEqual([]);
    expect(badge()).toBe("badge t-warn:!");
    expect(opsStatus().mark.line).toBe("1 no time yet");
    expect(clearWords().mood).toBe("happy");
    // No card waiting: happy, the amber mark says the rest.
    expect(rivetMood()).toBe("happy");
  });

  it("never reads the passed time a record's eta still says as a new time", () => {
    // The server writes eta "by 3:30pm" beside dueAt 3:30pm; at 4pm, with no later write, there is no new time.
    show(broken(), [prRecord({ dueAt: hoursAgo(0.5), eta: "by 3:30pm", why: "Rebuilding the cache" })]);
    expect(ownWhen()).toBe("No time yet");
  });

  it("shows a break the auto pick-up could not start yet (queue full) as counted in Rivet's own, with its why", () => {
    show(broken(), [prRecord({ state: "backlog", chat: undefined, by: "auto-pick-up", why: "queue full", askedForTimeAt: hoursAgo(0.5) })]);
    const row = ownRow();
    expect(row.classList.contains("is-counted")).toBe(true);
    expect(row.querySelector(".ask-when")!.textContent).toBe("No time yet");
    expect(row.querySelector(".ask-sub")!.textContent).toContain("queue full");
  });

  it("says a passed record has no time yet, asked when the server asked its chat", () => {
    show(broken(), [prRecord({ dueAt: hoursAgo(0.5), askedForTimeAt: hoursAgo(1 / 3) })]);
    expect(ownWhen()).toBe("No time yet, asked 3:40pm");
    asks.unmount();
    // An ask from a time before this one is not this time's.
    show(broken(), [prRecord({ dueAt: hoursAgo(0.5), askedForTimeAt: hoursAgo(2) })]);
    expect(ownWhen()).toBe("No time yet");
  });

  it("reads a moved record off its dueHistory: now its new time, was the one it missed, and why; counted once moved twice", () => {
    const move = { at: hoursAgo(0.4), dueAt: "2026-10-20T06:00:00.000Z", was: hoursAgo(0.5), why: "the rerun hit the same flake" };
    show(broken(), [prRecord({ askedForTimeAt: hoursAgo(0.5), dueAt: move.dueAt, dueHistory: [move] })]);
    expect(ownWhen()).toBe("Now 5:00pm, was 3:30pm · the rerun hit the same flake");
    expect(ownRow().classList.contains("is-counted")).toBe(false);
    asks.unmount();
    show(broken(), [prRecord({ dueAt: move.dueAt, dueHistory: [{ ...move, dueAt: hoursAgo(-0.5), why: "first" }, move] })]);
    expect(ownWhen()).toBe("Now 5:00pm, moved twice · the rerun hit the same flake");
    expect(ownRow().classList.contains("is-counted")).toBe(true);
  });

  it("says a moved record's why once, in Plan's words, when its record's why is the move's", () => {
    const why = "the PR's own chat is fixing it";
    const move = { at: hoursAgo(0.4), dueAt: "2026-10-20T06:00:00.000Z", was: hoursAgo(0.5), why };
    show(broken(), [prRecord({ dueAt: move.dueAt, dueHistory: [move], why })]);
    expect(ownWhen()).toBe("Now 5:00pm, was 3:30pm · the code change's own chat is fixing it");
    expect(ownRow().querySelector(".ask-sub")).toBeNull();
    asks.unmount();
    // A record whose why differs from the move's keeps both, even one the move's why ends with.
    show(broken(), [prRecord({ dueAt: move.dueAt, dueHistory: [move], why: "Rebuilding the cache" })]);
    expect(ownRow().querySelector(".ask-sub")?.textContent).toBe("Rebuilding the cache");
    asks.unmount();
    show(broken(), [prRecord({ dueAt: move.dueAt, dueHistory: [{ ...move, why: "tests were red · deploy queue" }], why: "deploy queue" })]);
    expect(ownWhen()).toBe("Now 5:00pm, was 3:30pm · tests were red · deploy queue");
    expect(ownRow().querySelector(".ask-sub")?.textContent).toBe("deploy queue");
  });

  it("has no Late list on Plan: Rivet's own puts its counted rows first and opens while it holds one", () => {
    const record = (key: string, extra: Partial<OpsStatus> & Record<string, unknown>) => ({ kind: "schedule", key, state: "in-progress", by: "Rivet", since: hoursAgo(2), updatedAt: hoursAgo(0.5), version: 1, ...extra }) as OpsStatus;
    const onTime = record("on-time", { dueAt: hoursAgo(-1) });
    const movedOnce = record("moved-once", { dueAt: hoursAgo(-2), dueHistory: [{ at: hoursAgo(0.5), dueAt: hoursAgo(-2), was: hoursAgo(1), why: "tests were red" }] });
    const noTime = record("no-time", { dueAt: hoursAgo(0.5), askedForTimeAt: hoursAgo(0.25) });
    const movedTwice = record("moved-twice", { dueAt: hoursAgo(-3), dueHistory: [{ at: hoursAgo(1), dueAt: hoursAgo(0.5), was: hoursAgo(1.5), why: "first" }, { at: hoursAgo(0.4), dueAt: hoursAgo(-3), was: hoursAgo(0.5), why: "deploy queue" }] });
    const el = document.createElement("div");
    document.body.append(el);
    const fold = () => el.querySelector<HTMLButtonElement>('.plan-fold[data-fold="own"]')!;
    const ids = () => [...el.querySelectorAll<HTMLElement>(".ask-row")].map((row) => [row.dataset.ask, row.classList.contains("is-counted")]);
    show(fixture(), [onTime, movedOnce]);
    asks.mount(el);
    if (fold().getAttribute("aria-expanded") === "true") fold().click();
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    // A counted row opens the fold on its own, first in the list.
    show(fixture(), [onTime, movedOnce, noTime]);
    asks.mount(el);
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(ids()[0]).toEqual(["schedule/no-time", true]);
    // Closed by hand, it stays closed until a new counted row comes.
    fold().click();
    asks.mount(el);
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    show(fixture(), [onTime, movedOnce, noTime, movedTwice]);
    asks.mount(el);
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(ids().slice(0, 2).map(([, counted]) => counted)).toEqual([true, true]);
    expect(ids().slice(2).map(([, counted]) => counted)).toEqual([false, false]);
    expect(el.querySelector('[data-ask="schedule/moved-once"] .ask-when')!.textContent).toBe("Now 6:00pm, was 3:00pm · tests were red");
    const plan = mountPlan();
    expect(plan.querySelector('[data-plan-group="late"], .plan-sec, .plan-row')).toBeNull();
    expect(plan.textContent).not.toMatch(/Late/);
  });

  it("reads no flag as late: a record given a new time with no move keeps it, and a late field is not read", () => {
    show(broken(), [prRecord({ askedForTimeAt: hoursAgo(0.5), dueAt: "2026-10-20T06:00:00.000Z" }), prRecord({ key: "other", late: true, eta: "3pm" })]);
    expect(planState(null).doing.filter((row) => row.late !== null || row.counted)).toEqual([]);
  });

  it("says rows in plain words: no repo or workflow names, and a PR number only to lead a PR with no title", () => {
    const run = { repo: REPO, id: 1, attempt: 1, workflow: "CI", title: "Merge #601", status: "completed", conclusion: "failure", event: "push", sha: "a".repeat(40), url: `https://github.com/${REPO}/actions/runs/1`, createdAt: hoursAgo(1), updatedAt: hoursAgo(1) };
    show(
      fixture({ github: { at: NOW, stale: false, prsComplete: true, prs: [redPr()], runs: [run] }, summary: { needs: 0, redCi: 1, failingSchedules: 0, appsDown: 0, disk: { freePct: 41, tone: "ok" } } }),
      [prRecord({ key: opsStatusKey("pr", "6100", REPO) }), { kind: "runner", key: "example-mac-2", state: "in-progress", since: NOW, updatedAt: NOW, version: 1 } as OpsStatus],
    );
    setComing([{ pr: 396, title: "Merge #396: apps keep the corner clear", stage: "building" }]);
    const plan = planState(null);
    const titles = plan.doing.map((row) => row.title);
    expect(titles).toHaveLength(5);
    expect(titles).toEqual(expect.arrayContaining(["Main build checks", "Login fix", "#6100: A code change", "Test machine on the Mac", "Merge: apps keep the corner clear"]));
    for (const title of titles) expect(title.replace(/^#6100: /, "")).not.toMatch(/#\d+|example-repo|·/);
  });

  it("still lists the rest when the reading lacks a part: no bridge, no apps", () => {
    const served = broken() as unknown as Record<string, unknown>;
    delete served.bridge;
    show(served as unknown as OpsResponse);
    expect(ops.failedItems(opsData.ops).map((item) => item.kind)).toEqual(["pr", "app"]);
    delete served.apps;
    show(served as unknown as OpsResponse);
    expect(ops.failedItems(opsData.ops).map((item) => item.kind)).toEqual(["pr"]);
    expect(planState(null).doing.map((row) => row.title)).toEqual(["Login fix"]);
  });

  it("gives Your asks what was fixed since midnight, newest first, and keeps no Done today of its own", () => {
    const fixed = (key: string, at: string, note: string) => ({ kind: "app", key, state: "fixed", since: at, updatedAt: at, version: 1, note }) as OpsStatus;
    show(fixture(), [
      fixed("paper-trail", "2026-10-20T01:00:00.000Z", "Paper Trail back up. It ran out of memory"),
      fixed("docs-site", "2026-10-20T03:00:00.000Z", "Docs Site restarted"),
      fixed("old", "2026-10-19T10:00:00.000Z", "Yesterday's fix"),
    ]);
    const plan = mountPlan();
    expect(plan.querySelector(".plan-lede")).toBeNull();
    expect(plan.querySelector('[data-plan-group="done"]')).toBeNull();
    expect(fixedToday().map((one) => [one.at, one.text])).toEqual([
      ["2026-10-20T03:00:00.000Z", "Docs Site restarted"],
      ["2026-10-20T01:00:00.000Z", "Paper Trail back up"],
    ]);
  });

  it("leads a fixed PR record's Done today line with its number, from the record's key, never its words", () => {
    const at = "2026-10-20T02:00:00.000Z";
    const pr = (key: string, note: string) => ({ kind: "pr", key, state: "fixed", since: at, updatedAt: at, version: 1, note }) as OpsStatus;
    show(fixture(), [
      pr(opsStatusKey("pr", "6777", REPO), "Rivet picked this up on its own and is opening a chat on it."),
      pr(opsStatusKey("pr", "41", "example-org/other-repo"), "Rebased and merged"),
      { kind: "app", key: "paper-trail", state: "fixed", since: at, updatedAt: at, version: 1, note: "Paper Trail back up" } as OpsStatus,
    ]);
    expect(fixedToday().map((one) => one.text)).toEqual([
      "#6777: Rivet picked this up on its own and is opening a chat on it",
      "#41: Rebased and merged",
      "Paper Trail back up",
    ]);
  });

  it("leads a PR record's line with its number once, never twice, and leaves other kinds alone", () => {
    const pr = { kind: "pr", key: opsStatusKey("pr", "6746", REPO), state: "fixed", since: NOW, updatedAt: NOW, version: 1 } as OpsStatus;
    expect(prRef(pr, "A code change")).toBe("#6746: A code change");
    expect(prRef(pr, "#6746 checks pass")).toBe("#6746 checks pass");
    expect(prRef(pr, "#6746: Checks pass")).toBe("#6746: Checks pass");
    expect(prRef(pr, "#67460 is another")).toBe("#6746: #67460 is another");
    expect(prRef({ ...pr, kind: "app", key: "6746" } as OpsStatus, "Paper Trail")).toBe("Paper Trail");
  });

  it("lists Ops' own Next rows when the reading carries them, future only", () => {
    show(fixture({ next: [{ key: "a", title: "Night sign-offs", at: "2026-10-20T12:00:00.000Z" }, { key: "b", title: "Gone", at: hoursAgo(1) }] }));
    expect(planState(null).next.map((one) => one.text)).toEqual(["Night sign-offs"]);
    const items = [...nextBody(null)!.querySelectorAll(".plan-item")].map((one) => one.textContent);
    expect(items).toEqual(["◷11:00pmNight sign-offs"]);
  });

  it("keeps a parked draft calm: no mark, All clear and its Parked line", () => {
    show(fixture({ github: { at: NOW, stale: false, prsComplete: true, prs: [redPr(true)], runs: [] } }), [prRecord({ state: "parked", chat: undefined, by: "rivet" })]);
    expect(badge()).toBeNull();
    expect(clearWords()).toMatchObject({ mood: "happy", parked: "Parked: 1 PR" });
    expect(statusParts().find((part) => part.key === "prs")).toMatchObject({ tone: "ok", text: "1 PR open, 1 parked" });
  });

  it("keeps a parked app calm too: off Plan, All clear and named on its Parked line", () => {
    const down = (since: string) => fixture({ apps: [{ ...(fixture().apps![0] as object), health: { ...up, state: "down", since } }], summary: { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 1, disk: { freePct: 41, tone: "ok" } } });
    const record = { kind: "app", key: opsStatusKey("app", "app"), state: "parked", by: "rivet", since: hoursAgo(2), updatedAt: hoursAgo(2), version: 1 } as OpsStatus;
    show(down(hoursAgo(3)), [record]);
    expect(failedItems(opsData.ops)).toEqual([]);
    expect(clearWords()).toMatchObject({ mood: "happy", parked: "Parked: App" });
  });
});

describe("Plan's Readings", () => {
  it("are pages under More, each opened by name, while Plan is on the home screen", () => {
    show(fixture());
    const plan = mountPlan();
    expect(plan.querySelector('[data-plan-group="readings"]')).toBeNull();
    expect(root.querySelector(".ops-pills")).toBeNull();
    ops.openOpsPage("usage");
    expect([app.tab, app.morePage, app.opsPage]).toEqual(["more", "usage", "usage"]);
    ops.openOpsPage("plan");
    expect([app.tab, app.opsPage]).toEqual(["progress", "plan"]);
  });
});

describe("Plan after round 1", () => {
  const OTHER = "example-org/other-repo";
  const whenOf = (id: string) => document.querySelector(`[data-ask="${id}"] .ask-when`)?.textContent;

  it("lists a failed deploy on an app still up under Rivet's own, in plain words, never red", () => {
    const apps = [{ ...(fixture().apps![0] as object), name: "Paper Trail", fly: { version: 2, machines: { started: 1, total: 1 }, checks: { passing: 1, total: 1 }, status: "deployed", lastRelease: { status: "failed", version: 2, at: hoursAgo(1) } } }];
    show(fixture({ apps, github: { at: NOW, stale: false, prsComplete: true, prs: [], runs: [], runners: { complete: true, online: 0, runners: [] } } }));
    const plan = mountPlan();
    const rows = [...mountOwn().querySelectorAll<HTMLElement>(".ask-row")];
    expect(rows.map((row) => [row.querySelector(".ask-title")!.textContent, row.querySelector(".ask-when")?.textContent ?? null])).toEqual(
      expect.arrayContaining([
        ["Paper Trail", "No time yet"],
      ]),
    );
    expect(document.body.textContent).not.toMatch(/\b(CI|runners?|GitHub)\b/);
    expect(reds(root)).toEqual([]);
  });

  it("keeps the failing schedules loading while Ops is open, and lets go when it closes", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date", "setInterval", "clearInterval"] });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const calls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/api/schedules")).length;
    show(fixture());
    mountPlan();
    await vi.advanceTimersByTimeAsync(0);
    const opened = calls();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(opened + 1);
    ops.unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toBe(opened + 1);
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("shows a record's eta through when() when it gives no dueAt, on the row and in its sheet", () => {
    show(broken(), [prRecord({ eta: "today 18:00" })]);
    const id = `pr/${opsStatusKey("pr", "5995", REPO)}`;
    mountPlan();
    mountOwn();
    expect(whenOf(id)).toBe("by 6:00pm");
    document.querySelector<HTMLButtonElement>(`[data-ask="${id}"]`)!.click();
    const fields = Object.fromEntries([...document.querySelectorAll(".ops-status-detail h3.ops-status-label")].map((label) => [label.textContent, label.nextElementSibling?.textContent]));
    expect(fields["Done by"]).toBe("by 6:00pm");
  });

  it("works out no time from a Coming row's own ETA: it is never Late on the phone's clock", () => {
    setComing([{ pr: 2100, title: "Idle loop", stage: "building", etaMinutes: 30, updatedAt: hoursAgo(1) }]);
    show(fixture());
    expect(mountPlan().querySelector('[data-plan-group="late"]')).toBeNull();
    expect(planState(null).doing.map((row) => [row.title, row.dueAt])).toEqual([["Idle loop", null]]);
  });

  it("joins a Coming row to the failed PR it fixes, as one row", () => {
    setComing([{ pr: 5995, title: "Login fix", stage: "building", etaMinutes: 30, updatedAt: hoursAgo(1) }]);
    show(broken());
    const plan = planState(null);
    expect(plan.doing.filter((row) => row.id.endsWith("5995")).map((row) => row.id)).toEqual([`pr/${opsStatusKey("pr", "5995", REPO)}`]);
  });

  it("keeps a quiet Coming row a working chat holds", () => {
    setComing([{ pr: 2101, title: "Quiet fix", stage: "building", chat: "quiet-fix", etaMinutes: 30, updatedAt: hoursAgo(7) }]);
    show(fixture());
    expect(planState(null).doing).toEqual([]);
    app.workers = { at: NOW, workers: [{ id: "w-quiet-fix", name: "quiet-fix", repo: REPO, chat: "quiet-fix", state: "working", lastOutputAt: null }] } as never;
    app.workersAt = Date.now();
    try {
      expect(planState(null).doing.map((row) => row.title)).toEqual(["Quiet fix"]);
    } finally {
      app.workers = null;
      app.workersAt = null;
    }
  });

  it("names the failing schedules Ops counts beyond the list it has, and keeps the count when the list is empty", async () => {
    const runs = [1, 2].map((h) => ({ id: `scan-${h}`, at: hoursAgo(h), result: "failed" }));
    let items: unknown[] = [{ id: "scan", name: "Security scan", on: true, lastRun: { result: "failed", at: hoursAgo(1) }, runs }];
    vi.stubGlobal("fetch", vi.fn((url: string) => (String(url).includes("/api/schedules") ? Promise.resolve(new Response(JSON.stringify({ at: null, stale: false, items }), { headers: { "content-type": "application/json" } })) : new Promise(() => {}))));
    const counted = fixture({ summary: { needs: 0, redCi: 0, failingSchedules: 2, appsDown: 0, disk: { freePct: 41, tone: "ok" } } });
    show(counted);
    mountPlan();
    await vi.waitFor(() => expect(ops.failedItems(opsData.ops).filter((item) => item.kind === "schedule")).toHaveLength(2));
    expect(ops.failedItems(opsData.ops).filter((item) => item.kind === "schedule").map((item) => item.title)).toEqual(["1 more schedule failing", expect.stringContaining("Security scan")]);
    ops.unmount();
    items = [];
    mountPlan();
    await vi.waitFor(() => expect(ops.failedItems(opsData.ops).filter((item) => item.kind === "schedule").map((item) => item.title)).toEqual(["2 schedules failing"]));
  });

  const countedOwn = () => ownRows().filter((row) => row.counted).length;

  it("leaves a late failed PR to the Coming row that joins it, as the summary does: no amber row and no mark", () => {
    setComing([{ pr: 5995, title: "Login fix", stage: "building", etaMinutes: 30, updatedAt: hoursAgo(1) }]);
    show(broken(), [prRecord({ dueAt: hoursAgo(0.2) })]);
    expect(ownRows().map((row) => row.id)).not.toContain(`pr/${opsStatusKey("pr", "5995", REPO)}`);
    expect(countedOwn()).toBe(0);
    expect(opsStatus().mark.dot).toBeNull();
  });

  it("keeps a row for a pick-up waiting on a time after its app is back up", () => {
    show(fixture(), [{ kind: "app", key: opsStatusKey("app", "app"), state: "backlog", by: "auto-pick-up", why: "queue full", askedForTimeAt: hoursAgo(0.5), since: hoursAgo(1), updatedAt: hoursAgo(0.5), version: 1 } as OpsStatus]);
    expect(ownRows().map((row) => [row.title, row.counted])).toEqual([["App", true]]);
  });

  it("lists a record once whether a break or the record list names it, and a break with no record uncounted", () => {
    show(broken(), [prRecord({ state: "backlog", chat: undefined, by: "auto-pick-up", why: "queue full", askedForTimeAt: hoursAgo(0.5) })]);
    const rows = ownRows();
    expect(rows.filter((row) => row.id === `pr/${opsStatusKey("pr", "5995", REPO)}`)).toHaveLength(1);
    expect(rows.filter((row) => !row.record).every((row) => !row.counted)).toBe(true);
  });

  it("lists a failed PR's pick-up waiting on a time once when a Coming record joins its break, and leaves the break to Coming without it", () => {
    setComing([{ pr: 5995, title: "Login fix", stage: "building", etaMinutes: 30, updatedAt: hoursAgo(1) }]);
    const late = { kind: "coming", key: "5995", state: "in-progress", why: "Fixing it", dueAt: hoursAgo(0.2), since: hoursAgo(1), updatedAt: hoursAgo(1), version: 1 } as OpsStatus;
    show(broken(), [prRecord({ state: "backlog", chat: undefined, by: "auto-pick-up", why: "queue full", askedForTimeAt: hoursAgo(0.5) }), late]);
    expect(ownRows().filter((row) => row.id === `pr/${opsStatusKey("pr", "5995", REPO)}`)).toHaveLength(1);
    expect(countedOwn()).toBe(1);
    // With the Coming record alone, the break is Coming's: no row of Rivet's own counts it.
    show(broken(), [late]);
    expect(countedOwn()).toBe(0);
  });

  it("gives a failed PR joined to its Coming row the Coming record's note as its why", () => {
    setComing([{ pr: 5995, title: "Login fix", stage: "building", etaMinutes: 30, updatedAt: hoursAgo(1) }]);
    show(broken(), [{ kind: "coming", key: "5995", state: "in-progress", note: "Disk cleanup is delaying the repair", since: hoursAgo(1), updatedAt: hoursAgo(1), version: 1 } as OpsStatus]);
    expect(planState(null).doing.find((row) => row.id === `pr/${opsStatusKey("pr", "5995", REPO)}`)?.why).toBe("Disk cleanup is delaying the repair");
  });

  it("takes a joined Coming row's own words over the failed PR's when no record gives a why", () => {
    setComing([{ pr: 5995, title: "Login fix", what: "Disk cleanup is delaying the repair", stage: "building", etaMinutes: 30, updatedAt: hoursAgo(2) }]);
    show(broken(), [{ kind: "coming", key: "5995", state: "in-progress", since: hoursAgo(2), updatedAt: hoursAgo(2), version: 1 } as OpsStatus]);
    expect(planState(null).doing.find((row) => row.id === `pr/${opsStatusKey("pr", "5995", REPO)}`)?.why).toBe("Disk cleanup is delaying the repair");
  });

  it("says a joined Coming row's own words in Plan's words: no CI or runner", () => {
    setComing([{ pr: 5995, title: "Login fix", what: "Waiting for CI runner", stage: "building", etaMinutes: 90, updatedAt: hoursAgo(0.5) }]);
    show(broken());
    mountPlan();
    const why = mountOwn().querySelector<HTMLElement>(`[data-ask="pr/${opsStatusKey("pr", "5995", REPO)}"] .ask-sub`)!.textContent!;
    expect(why).toBe("Waiting for test machine");
    expect(why).not.toMatch(/\bCI\b|runner/i);
  });

  it("swaps whole CI phrases before the bare CI word, keeping the first letter's case", () => {
    expect(ops.planWords("Waiting for CI runners")).toBe("Waiting for test machines");
    expect(ops.planWords("CI runner offline")).toBe("Test machine offline");
    expect(ops.planWords("Two CI runs queued")).toBe("Two test runs queued");
    expect(ops.planWords("CI run stuck")).toBe("Test run stuck");
    expect(ops.planWords("After a CI failure")).toBe("After a test failure");
    expect(ops.planWords("CI failures on main")).toBe("Test failures on main");
    expect(ops.planWords("Waiting on CI checks")).toBe("Waiting on tests");
    expect(ops.planWords("One CI check left")).toBe("One test left");
    expect(ops.planWords("CI Checks")).toBe("Tests");
    expect(ops.planWords("Rerunning CI")).toBe("Rerunning tests");
  });

  it("leaves URLs, paths and code spans as written, swapping only the prose round them", () => {
    const url = "https://api.github.com/repos/example-org/example-repo/actions/runners";
    expect(ops.planWords(`Checking ${url} for CI runners`)).toBe(`Checking ${url} for test machines`);
    expect(ops.planWords("CI run fixed in .github/workflows/ci.yml")).toBe("Test run fixed in .github/workflows/ci.yml");
    expect(ops.planWords("Restart `ci-runner PR` on the runner")).toBe("Restart `ci-runner PR` on the test machine");
    expect(ops.planWords("`x` CI runner")).toBe("`x` test machine");
  });

  it("shows a why holding a URL with the URL whole", () => {
    const url = "https://api.github.com/repos/example-org/example-repo/actions/runners";
    show(broken(), [prRecord({ why: `Checking ${url}` })]);
    mountPlan();
    const row = mountOwn().querySelector<HTMLElement>(`[data-ask="pr/${opsStatusKey("pr", "5995", REPO)}"]`)!;
    expect(row.querySelector(".ask-sub")!.textContent).toBe(`Checking ${url}`);
  });

  it("keeps a PR's own title, swapping only its CI word", () => {
    show(fixture({ github: { at: NOW, stale: false, prsComplete: true, prs: [{ ...redPr(), title: "CI cache fix for Field Notes on main" }], runs: [] } }));
    mountPlan();
    const title = mountOwn().querySelector<HTMLElement>(`[data-ask="pr/${opsStatusKey("pr", "5995", REPO)}"] .ask-title`)!.textContent!;
    expect(title).toMatch(/cache fix for Field Notes on main$/);
    expect(title).not.toMatch(/\bCI\b|main build/);
  });

  it("says a failed main run, red PRs and offline runners with no CI, runner, GitHub or PR words", () => {
    const run = { repo: REPO, id: 1, attempt: 1, workflow: "CI", title: "Merge #601", status: "completed", conclusion: "failure", event: "push", branch: "main", sha: "a".repeat(40), url: `https://github.com/${REPO}/actions/runs/1`, createdAt: hoursAgo(2), updatedAt: hoursAgo(2), failedJobs: ["CI complete"] };
    const prs = [redPr(), ...[1, 2, 3, 4].map((n) => ({ ...redPr(), number: 6000 + n, title: `Fix ${n}`, url: `https://github.com/${REPO}/pull/${6000 + n}` }))];
    show(
      fixture({
        github: { at: NOW, stale: false, prsComplete: true, prs, runs: [run], runners: { complete: true, online: 0, offline: 1, busy: 0, runners: [{ name: "example-mac-1", status: "offline", busy: false, labels: [] }] } },
        summary: { needs: 0, redCi: 1, failingSchedules: 0, appsDown: 0, disk: { freePct: 41, tone: "ok" } },
      }),
    );
    mountPlan();
    mountOwn();
    expect(ops.failedItems(opsData.ops).map((item) => item.kind)).toEqual(expect.arrayContaining(["ci", "pr", "runner"]));
    expect(document.body.textContent).toContain("Tests failing on the main build");
    expect(document.body.textContent).not.toMatch(/\bCI\b|runner|GitHub|PR\b/);
  });

  it("gives PR 41 in two repos a row each, with each repo's own record", () => {
    setComing([
      { pr: 41, title: "Login fix", stage: "building" },
      { pr: 41, title: "Chart fix", stage: "building", chat: "chart-fix" },
    ]);
    (app.board as unknown as { board: { chats: unknown[] } }).board.chats = [{ name: "chart-fix", repo: OTHER, state: "working", prs: [41] }];
    show(fixture(), [
      prRecord({ key: opsStatusKey("pr", "41", REPO), dueAt: "2026-10-20T06:00:00.000Z" }),
      prRecord({ key: opsStatusKey("pr", "41", OTHER), eta: "by 6pm" }),
    ]);
    // Coming rows under way left Plan with Being done; planState still joins each to its own repo's record.
    const doing = planState(null).doing.filter((row) => row.kind === "coming");
    expect(doing.map((row) => [row.id, row.dueAt, row.eta])).toEqual([
      [`coming/${REPO}/41`, "2026-10-20T06:00:00.000Z", null],
      [`coming/${OTHER}/41`, null, "by 6:00pm"],
    ]);
  });

  it("gives one PR-less title in two repos a row each, the record on its repo's row; one repo's row alone keeps it", () => {
    const chats = [{ name: "lobby", repo: OTHER, state: "working" }];
    const setBoth = (coming: Record<string, unknown>[]) => {
      setComing(coming);
      (app.board as unknown as { board: { chats: unknown[] } }).board.chats = chats;
    };
    const key = opsStatusKey("coming", "Lobby art");
    const due = "2026-10-20T06:00:00.000Z";
    const record = (extra: Record<string, unknown> = {}) => ({ kind: "coming", key, state: "in-progress", dueAt: due, since: hoursAgo(1), updatedAt: hoursAgo(1), version: 1, ...extra }) as OpsStatus;
    const rows = () => Object.fromEntries(planState(null).doing.filter((row) => row.kind === "coming").map((row) => [row.id, row.dueAt]));
    setBoth([
      { title: "Lobby art", stage: "building", chat: "lobby" },
      { title: "Lobby art", stage: "building" },
    ]);
    show(fixture(), [record()]);
    expect(rows()).toEqual({ [`coming/${REPO}/${key}`]: due, [`coming/${OTHER}/${key}`]: null });
    // The other repo's record is keyed in its repo, so each row keeps its own, alone or not.
    const other = { repo: OTHER, key: opsStatusKey("coming", "Lobby art", OTHER) };
    show(fixture(), [record(other)]);
    expect(rows()).toEqual({ [`coming/${REPO}/${key}`]: null, [`coming/${OTHER}/${key}`]: due });
    setBoth([{ title: "Lobby art", stage: "building", chat: "lobby" }]);
    show(fixture(), [record(other)]);
    expect(rows()).toEqual({ [`coming/${OTHER}/${key}`]: due });
    // The default repo's record no longer lands on the other repo's row: it is listed as a record of its own.
    show(fixture(), [record()]);
    expect(rows()).toEqual({ [`coming/${OTHER}/${key}`]: null, [`coming/${key}`]: due });
  });

  it("says a failed read in a grey line, never a red box", () => {
    opsData.error = "Ops could not load: the server did not answer.";
    show(fixture());
    opsData.error = "Ops could not load: the server did not answer.";
    mountPlan();
    // In plain words, never the server's own.
    expect(root.querySelector(".plan-note")?.textContent).toBe("Couldn't load Ops.");
    expect(root.querySelector(".ops-notice")).toBeNull();
    expect(reds(root)).toEqual([]);
  });

});

describe("Dismiss on Plan", () => {
  const sent: string[] = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (!String(url).startsWith("/api/ops/dismissals/")) return new Promise(() => {});
        sent.push(`${init?.method} ${url}`);
        return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
      }),
    );
    opsData.statusesLoaded = true;
    opsData.dismissals = [];
  });
  afterEach(() => {
    opsData.statusesLoaded = false;
    opsData.dismissals = [];
  });

  const withDismiss = (el: ParentNode) => [...el.querySelectorAll<HTMLElement>("li")].filter((li) => li.querySelector(".plan-dismiss")).map((li) => li.querySelector(".ask-row")!.getAttribute("data-ask")!.split("/")[0]);

  it("shows Dismiss only on a break nobody is on, and keeps a dismissed one in a fold with Bring back", async () => {
    show(broken(), [prRecord()]);
    mountPlan();
    mountOwn();
    expect(withDismiss(document.body)).toEqual(["app"]);
    document.querySelector<HTMLButtonElement>(".plan-dismiss")!.click();
    await vi.waitFor(() => expect(sent).toEqual(["PUT /api/ops/dismissals/app/app"]));
    expect(document.querySelector('[data-ask="app/app"]')).toBeNull();
    const fold = root.querySelector<HTMLButtonElement>('[data-plan-group="dismissed"] .plan-fold')!;
    expect(fold.textContent).toContain("1 dismissed");
    fold.click();
    root.querySelector<HTMLButtonElement>(".plan-bring-back")!.click();
    await vi.waitFor(() => expect(sent).toContain("DELETE /api/ops/dismissals/app/app"));
    expect(document.querySelector('[data-ask="app/app"]')).not.toBeNull();
    expect(withDismiss(document.body)).toEqual(["app"]);
  });
});
