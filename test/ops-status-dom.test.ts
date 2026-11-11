// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppStatus, MacSnapshot, OpsResponse, PullRequest, WorkflowRun } from "../src/shared/ops.js";
import type { OpsStatus } from "../src/shared/ops-status.js";
import { OPS_STATUS_KEY_PATTERN } from "../src/shared/ops-status.js";
import type { Worker } from "../src/shared/workers.js";
import { noteDismissal, opsData, refreshOps } from "../web/src/ops-data.js";
import { app, changed } from "../web/src/state.js";
import { mount, unmount } from "../web/src/views/ops.js";
import { bringBack, ciItem, diskItem, dismissable, dismissed, dismissItem, appItem, macItem, markOf, openStatus, prItem, runnerItem } from "../web/src/views/ops-status.js";
import { closeSheet } from "../web/src/views/sheet.js";
import * as asks from "../web/src/views/your-asks.js";

const NOW = Date.parse("2026-10-01T04:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const MS = "example-org/example-repo";

function run(extra: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    repo: MS, id: 1, attempt: 1, workflow: "CI", title: "Rivet: usage tile", status: "completed", conclusion: "failure", event: "push", sha: "abc",
    url: "https://github.com/x/actions/runs/1", createdAt: at(50), updatedAt: at(40), failedJobs: ["Lint"], ...extra,
  };
}

function pr(number: number, state: PullRequest["checks"]["state"], extra: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: MS, number, title: `PR ${number}`, url: `https://github.com/${MS}/pull/${number}`, draft: false, author: "dev", labels: [], headAt: at(90), updatedAt: at(30),
    checks: { state, passed: 3, failed: state === "fail" ? 2 : 0, pending: 0, failing: state === "fail" ? ["rivet", "lint"] : [] }, ...extra,
  };
}

function appRow(id: string, state: AppStatus["health"]["state"]): AppStatus {
  return {
    id, name: id === "paper-trail" ? "Paper Trail" : id, app: id, url: "https://x",
    health: { state, status: state === "down" ? 503 : 200, ms: 80, checkedAt: at(1), since: at(25), fails: 3 }, fly: null,
  };
}

function status(kind: OpsStatus["kind"], key: string, extra: Partial<OpsStatus> = {}): OpsStatus {
  return { kind, key, state: "in-progress", since: at(120), updatedAt: at(5), version: 1, ...extra };
}

describe("failed items' keys", () => {
  const HASHED = /_[0-9a-z]{7}$/;

  it("derives a stable kind and key from each item's own data", () => {
    const ci = ciItem(run())!;
    expect(ci).toMatchObject({ kind: "ci", failedAt: at(40) });
    expect(ci.key).toMatch(/^ci_[0-9a-z]{7}$/);
    expect(ciItem(run({ repo: "example-org/other-repo", workflow: "deploy" }))?.key).toBe("other-repo/deploy");
    expect(ciItem(run({ conclusion: "success" }))).toBeNull();
    expect(prItem(pr(2965, "fail"))).toMatchObject({ kind: "pr", key: "2965", failedAt: at(90) });
    expect(prItem(pr(12, "fail", { repo: "example-org/other-repo" }))?.key).toBe("other-repo/12");
    expect(prItem(pr(2966, "pending"))).toBeNull();
    expect(appItem(appRow("paper-trail", "down"))).toMatchObject({ kind: "app", key: "paper-trail", failedAt: at(25) });
    expect(appItem(appRow("paper-trail", "up"))).toBeNull();
    expect(runnerItem("example-runner-3").key).toBe("example-runner-3");
    expect(runnerItem("Example_Mac 2").key).toMatch(/^example-mac-2_[0-9a-z]{7}$/);
    expect(diskItem({ label: "Macintosh HD", totalBytes: 100, freeBytes: 3, runners: true }).key).toMatch(/^macintosh-hd_[0-9a-z]{7}$/);
    expect(ciItem(run())!.key).toBe(ci.key);
  });

  it("never gives two names one key, however they slug or however long they are", () => {
    const long = "Build and test every web client on every phone size we ship";
    const pairs = [
      ["Lint API", "Lint_API"],
      ["CI / Deploy", "CI + Deploy"],
      ["CI", "ci"],
      ["deploy", "deploy-"],
      [`${long} (a)`, `${long} (b)`],
      ["x".repeat(200), `${"x".repeat(199)}y`],
    ];
    for (const repo of ["example-org/example-repo", `example-org/${"Long-Repo".repeat(10)}`]) {
      for (const [a, b] of pairs) {
        const [ka, kb] = [ciItem(run({ repo, workflow: a! }))!.key, ciItem(run({ repo, workflow: b! }))!.key];
        expect(ka, `${a} / ${b}`).not.toBe(kb);
        for (const key of [ka, kb]) {
          expect(key).toMatch(OPS_STATUS_KEY_PATTERN);
          expect(key.length).toBeLessThanOrEqual(100);
        }
        expect(runnerItem(a!).key).not.toBe(runnerItem(b!).key);
        expect(diskItem({ label: a!, totalBytes: 1, freeBytes: 0, runners: false }).key).not.toBe(diskItem({ label: b!, totalBytes: 1, freeBytes: 0, runners: false }).key);
      }
    }
    // A name already a plain slug is its own key; anything cut or changed carries a hash.
    expect(ciItem(run({ workflow: "deploy" }))!.key).toBe("deploy");
    expect(ciItem(run({ workflow: "x".repeat(200) }))!.key).toMatch(HASHED);
    expect(ciItem(run({ workflow: "Lint API" }))!.key).toMatch(/^lint-api_/);
  });
});

describe("the status sheet", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    // The Code page's actions list loads on its own; it never answers here.
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    opsData.at = Date.now();
    opsData.opsAt = { mono: performance.now(), wall: Date.now() };
    opsData.statuses = [
      status("ci", ciItem(run())!.key, { note: "Flaky login test; rerun queued", eta: "today 18:00", chat: "ci-fix", pr: 297, by: "rivet" }),
      status("pr", "2965", { state: "backlog" }),
      status("pr", "2970", { state: "fixed" }),
    ];
  });
  afterEach(() => {
    closeSheet();
    unmount();
    document.body.replaceChildren();
    localStorage.clear();
    opsData.ops = null;
    opsData.statuses = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const fields = () =>
    Object.fromEntries([...document.querySelectorAll(".ops-status-detail h3.ops-status-label")].map((label) => [label.textContent, label.nextElementSibling?.textContent]));

  it("names the chat on work under way in On it: the status's chat, else who set it", () => {
    opsData.statuses = [status("app", "paper-trail", { state: "investigating", by: "rivet" }), status("pr", "2965", { state: "investigating", chat: "fix-chat", by: "rivet" })];
    openStatus(appItem(appRow("paper-trail", "down"))!);
    expect(fields().Who).toBe("rivet");
    closeSheet();
    openStatus(prItem(pr(2965, "fail"))!);
    expect(fields().Who).toBe("Chat fix-chat");
  });

  it("reads a PR as the live chat's whose worktree has its branch checked out, and follows the crew", () => {
    const worker = (chat: string, branch: string, repo: Worker["repo"] = MS): Worker => ({ id: chat.padEnd(16, "0").slice(0, 16), name: chat, repo, chat, state: "working", lastOutputAt: NOW, branch });
    app.workers = { at: at(0), workers: [worker("regions-login-fix", "dev/regions-login-fix")] };
    app.workersAt = NOW;
    opsData.statuses = [];
    try {
      openStatus(prItem(pr(3788, "fail", { branch: "dev/regions-login-fix" }))!);
      expect(fields().Latest).toBe("regions-login-fix has this PR's branch checked out.");
      expect(document.querySelector(".ops-status-chat")?.textContent).toBe("Chat regions-login-fix");
      // The open sheet follows the crew: the chat leaves, Rivet is picking it up.
      app.workers = { at: at(0), workers: [] };
      changed();
      expect(document.querySelector(".ops-status-top .ops-pill-state")?.textContent).toBe("Queued");
      expect(document.querySelector(".ops-status-chat")).toBeNull();
    } finally {
      app.workers = null;
      app.workersAt = null;
    }
  });

  it("opens with what happened, the status, why, start, who, done by and last update", () => {
    opsData.statuses = [
      status("ci", ciItem(run())!.key, { note: "Flaky login test; rerun queued", why: "Rerunning after the flaky login test was quarantined", dueAt: new Date(NOW + 90 * 60_000).toISOString(), chat: "ci-fix", pr: 297, by: "rivet" }),
    ];
    openStatus(ciItem(run())!);
    const sheet = document.querySelector(".sheet")!;
    expect(sheet.querySelector(".sheet-title")?.textContent).toBe("Main build checks");
    const detail = sheet.querySelector(".ops-status-detail")!;
    expect(detail.querySelector(".ops-status-top")?.textContent).toBe(`In handci-fixKey: ci ${ciItem(run())!.key}`);
    expect(fields()["What happened"]).toBe("CI failure on mainRivet: usage tileFailed jobs: Lint");
    expect(fields().Latest).toBe("Rerunning after the flaky login test was quarantined");
    // The record says two hours, the run forty minutes: the earlier wins.
    expect(fields()["Failing since"]).toMatch(/^(?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m$/);
    expect(fields()["Done by"]).toMatch(/^(?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m$/);
    expect(fields()["Last updated"]).toMatch(/^(?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m by rivet$/);
    const link = detail.querySelector<HTMLAnchorElement>(".ops-status-link");
    expect([link?.textContent, link?.getAttribute("href")]).toEqual(["PR #297", `https://github.com/${MS}/pull/297`]);
    expect(detail.querySelector(".ops-status-chat")?.textContent).toBe("Chat ci-fix");
    expect(detail.querySelector<HTMLAnchorElement>(".ops-status-open")?.getAttribute("href")).toBe("https://github.com/x/actions/runs/1");
    expect(detail.querySelector(".t-bad")).toBeNull();
  });

  it("says plainly when nothing has been recorded: Rivet is picking it up, time coming", () => {
    openStatus(appItem(appRow("paper-trail", "down"))!);
    const detail = document.querySelector(".ops-status-detail")!;
    // An app with no record: one line, what happened and since when.
    expect(Object.keys(fields())).toEqual(["What happened", "Failing since"]);
    expect(fields()).toMatchObject({ "What happened": "Down: HTTP 503 on 3 checks in a row" });
    expect(fields()["Failing since"]).toMatch(/^(?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m$/);
    expect(detail.querySelector(".ops-status-note")?.textContent).toBe("Rivet is picking this up");
    expect(detail.querySelector(".ops-status-open")).toBeNull();
    expect(detail.querySelector(".t-bad")).toBeNull();
    closeSheet();

    openStatus(runnerItem("example-mac-6")!);
    expect(fields()).toMatchObject({ "What happened": "Offline", Who: "Rivet, picking it up", "Done by": "No time yet", "Last updated": "Never" });
    expect(fields().Latest).toMatch(/^No update yet/);
  });
});

describe("loading statuses", () => {
  afterEach(() => {
    opsData.ops = null;
    opsData.statuses = null;
    opsData.at = 0;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("publishes Ops while the statuses hang, keeps the last ones, and asks again after 10 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const asked: string[] = [];
    const fresh = [status("pr", "2965", { state: "fixed" })];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        asked.push(path);
        if (path !== "/api/ops/status") return Promise.resolve(json(path === "/api/ops" ? { now: new Date().toISOString(), summary: {} } : path === "/api/ops/timeline" ? { events: [] } : { briefing: null }));
        if (asked.filter((p) => p === path).length > 1) return Promise.resolve(json({ statuses: fresh }));
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }),
    );
    const known = [status("ci", "deploy", { state: "backlog" })];
    opsData.statuses = known;
    const count = (path: string) => asked.filter((p) => p === path).length;

    await refreshOps();
    expect(opsData.ops).not.toBeNull();
    await refreshOps();
    expect([count("/api/ops"), count("/api/ops/status")]).toEqual([2, 1]);
    expect(opsData.statuses).toBe(known);

    await vi.advanceTimersByTimeAsync(10_000);
    await refreshOps();
    await vi.waitFor(() => expect(opsData.statuses).toEqual(fresh));
    expect([count("/api/ops"), count("/api/ops/status")]).toEqual([3, 2]);
  });
});

describe("Dismiss and being fixed", () => {
  const puts: string[] = [];
  const ops = (trailSince = at(25)): OpsResponse => ({
    now: new Date(NOW).toISOString(), bridge: { connected: true }, defaultRepo: MS,
    github: { at: at(1), prs: [], runs: [run()], runners: null, queue: null, merged: null, sources: null, stale: false },
    mac: null, claude: null, flyAt: null, flyStale: false, flySource: null, healthStaleSince: null,
    apps: [{ ...appRow("paper-trail", "down"), health: { ...appRow("paper-trail", "down").health, since: trailSince } }, appRow("field-notes", "down")],
    summary: { needs: 0, redCi: 1, failingSchedules: 0, appsDown: 2, disk: { freePct: null, tone: "info" } },
  });
  /** The page; Plan's comes with Your asks beside it, Rivet's own unfolded, which holds what Rivet is on. */
  const page = (on: "plan" | "machines") => {
    unmount();
    asks.unmount();
    const el = document.createElement("div");
    const host = document.createElement("div");
    el.append(host);
    document.body.replaceChildren(el);
    app.tab = "progress";
    app.opsPage = on;
    mount(host);
    if (on === "plan") {
      const own = document.createElement("div");
      el.append(own);
      asks.mount(own);
      const fold = own.querySelector<HTMLButtonElement>('.plan-fold[data-fold="own"]');
      if (fold?.getAttribute("aria-expanded") === "false") fold.click();
    }
    return el;
  };
  /** Plan's and Rivet's own rows, each with " +Dismiss" when it offers one. */
  const rows = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLElement>(".plan-rows li, .asks-rows li")].map(
      (li) => `${li.querySelector(".plan-row")?.getAttribute("data-plan") ?? li.querySelector(".ask-row")!.getAttribute("data-ask")}${li.querySelector(".plan-dismiss") ? " +Dismiss" : ""}`,
    );

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    puts.length = 0;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/ops/dismissals/") && init?.method === "PUT") {
        puts.push(String(url));
        return Promise.resolve(new Response(JSON.stringify({}), { status: 201, headers: { "content-type": "application/json" } }));
      }
      return new Promise(() => {});
    });
    opsData.at = Date.now();
    opsData.opsAt = { mono: performance.now(), wall: Date.now() };
    opsData.ops = ops();
    // An agent on Field Notes; nobody on Paper Trail or the CI run.
    opsData.statuses = [status("app", "field-notes", { chat: "notes-fix" })];
    opsData.dismissals = [];
    opsData.timeline = null;
  });
  afterEach(() => {
    closeSheet();
    unmount();
    asks.unmount();
    document.body.replaceChildren();
    localStorage.clear();
    opsData.ops = null;
    opsData.statuses = null;
    opsData.dismissals = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps an offline runner, a full Mac disk and the Mac's faults amber while an agent is on them, and muted once dismissed", () => {
    const runners = [{ name: "example-runner-2", status: "offline", busy: false, labels: [] }];
    const volume = { label: "Data", freeBytes: 1, totalBytes: 100, runners: false };
    const mac = { at: at(1), stale: false, volumes: [volume], load: { one: 1, five: 1, fifteen: 1, cpus: 8 }, memory: { freePct: 40, pressure: "normal" }, uptimeSec: 3600, runners: [], chatRunner: true } as unknown as MacSnapshot;
    opsData.ops = { ...ops(), bridge: { connected: false }, mac, github: { ...ops().github!, runners: { complete: true, online: 0, busy: 0, offline: 1, runners } } } as unknown as OpsResponse;
    const runner = runnerItem("example-runner-2");
    const disk = diskItem(volume);
    expect(macItem({ ...mac, runners: [], memory: { ...mac.memory, pressure: "normal" } }, true)).toBeNull();
    const faults = macItem(mac, false)!;
    const tones = (el: HTMLElement) => {
      const runnerRow = [...el.querySelectorAll<HTMLElement>(".ops-row")].find((row) => row.textContent!.includes("example-runner-2"))!;
      const tags = [...el.querySelectorAll<HTMLElement>(".ops-tags")].find((one) => one.textContent!.includes("Bridge offline"))!;
      return { runner: runnerRow.className, disk: el.querySelector<HTMLElement>(".ops-disk")!.className, bridge: tags.querySelector(".ops-tag")!.className };
    };
    opsData.statuses = [status(runner.kind, runner.key, { chat: "ci-fix" }), status(disk.kind, disk.key, { chat: "disk-fix" }), status(faults.kind, faults.key, { chat: "mac-fix" })];
    expect(tones(page("machines"))).toEqual({ runner: "ops-row box s-warn", disk: "ops-disk t-warn", bridge: "ops-tag t-warn" });
    opsData.statuses = [];
    opsData.dismissals = [runner, disk, faults].map((item) => ({ kind: item.kind, key: item.key, mark: markOf(item), at: at(1) }));
    expect(tones(page("machines"))).toEqual({ runner: "ops-row box s-idle", disk: "ops-disk t-idle", bridge: "ops-tag t-idle" });
  });

  it("offers Dismiss on Plan only on what nobody is on", () => {
    const el = page("plan");
    expect(rows(el)).toEqual(expect.arrayContaining(["app/paper-trail +Dismiss", "app/field-notes"]));
    expect(rows(el)).not.toContain("app/field-notes +Dismiss");
  });

  it("a dismissed break leaves Plan's rows for its fold, and is back with its Dismiss once it breaks anew", async () => {
    let el = page("plan");
    [...el.querySelectorAll("li")].find((li) => li.querySelector('[data-plan="app/paper-trail"],[data-ask="app/paper-trail"]'))!.querySelector<HTMLButtonElement>(".plan-dismiss")!.click();
    await vi.waitFor(() => expect(puts).toEqual(["/api/ops/dismissals/app/paper-trail"]));
    el = page("plan");
    expect(rows(el).some((row) => row.startsWith("app/paper-trail"))).toBe(false);
    expect(el.querySelector('[data-plan-group="dismissed"] .plan-fold')?.textContent).toContain("1 dismissed");
    expect(dismissed(appItem(opsData.ops!.apps[0]!))).toBe(true);
    // It recovered and broke again: a new mark, and it is back with its Dismiss.
    opsData.ops = ops(at(2));
    el = page("plan");
    expect(rows(el)).toContain("app/paper-trail +Dismiss");
    expect(el.querySelector('[data-plan-group="dismissed"]')).toBeNull();
  });

  it("keeps an app dismissed while its run of failed checks grows, and its section calm", () => {
    const trail = () => opsData.ops!.apps[0]!;
    opsData.dismissals = [{ kind: "app", key: "paper-trail", mark: markOf(appItem(trail())!), at: at(1) }];
    // The next probe fails too: the same outage, so the same mark.
    opsData.ops = { ...opsData.ops!, apps: [{ ...trail(), health: { ...trail().health, fails: 4 } }, opsData.ops!.apps[1]!] };
    expect(dismissed(appItem(trail()))).toBe(true);
    // With Field Notes back up, only the dismissed Paper Trail is down: its section is calm, not amber.
    opsData.ops = { ...opsData.ops!, apps: [trail(), appRow("field-notes", "up")], summary: { ...opsData.ops!.summary, appsDown: 1 } };
    expect(page("machines").querySelector('[data-section="apps"] .ops-sec-line')?.className).toBe("ops-sec-line t-ok");
  });

  it("offers and applies no Dismiss before the statuses load, since someone may be on it", () => {
    const plain = run({ failedJobs: ["Repo gates"] });
    noteDismissal(ciItem(plain)!.kind, ciItem(plain)!.key, markOf(ciItem(plain)!));
    expect(dismissed(ciItem(plain))).toBe(true);
    // One Fix it's record before the whole list has loaded says nothing of the rest.
    opsData.statuses = [status("app", "paper-trail", { state: "investigating" })];
    opsData.statusesLoaded = false;
    expect(dismissable(ciItem(plain))).toBe(false);
    expect(dismissed(ciItem(plain))).toBe(false);
    opsData.statusesLoaded = true;
  });

  it("says how many of a PR's failed checks the bridge did not name", () => {
    const cut = pr(6390, "fail", { checks: { state: "fail", passed: 0, failed: 12, pending: 0, failing: ["rivet", "lint"] } });
    expect(prItem(cut)!.what).toEqual(["12 checks failed", "rivet, lint, 10 not named"]);
  });

  it("sends a Bring back and a second Dismiss in the order they were tapped", async () => {
    const sent: string[] = [];
    let land!: () => void;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      sent.push(`${init?.method} ${url}`);
      const reply = () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      // The first Dismiss hangs until the test lets it land; every later write answers at once.
      if (sent.length === 1) return new Promise<Response>((resolve) => (land = () => resolve(reply())));
      return Promise.resolve(reply());
    });
    const trail = appItem(opsData.ops!.apps[0]!)!;
    dismissItem(trail);
    bringBack(trail);
    dismissItem(trail);
    await Promise.resolve();
    expect(sent).toEqual(["PUT /api/ops/dismissals/app/paper-trail"]);
    land();
    // Once every write has landed, one load reads the stored list again.
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    expect(sent).toEqual(["PUT /api/ops/dismissals/app/paper-trail", "DELETE /api/ops/dismissals/app/paper-trail", "PUT /api/ops/dismissals/app/paper-trail", "GET /api/ops/dismissals"]);
    expect(dismissed(trail)).toBe(true);
  });
});
