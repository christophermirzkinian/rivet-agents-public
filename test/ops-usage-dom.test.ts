// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accountsTotal, codexCells, gradeAccounts, MAX_CLAUDE_LIMITS, sumCells, type ClaudeLimit, type OpsResponse } from "../src/shared/ops.js";
import { clock, when } from "../src/shared/when.js";
import { githubCurrent, healthCurrent, macCurrent, opsData, refreshOps } from "../web/src/ops-data.js";
import { app } from "../web/src/state.js";
import * as ops from "../web/src/views/ops.js";

const NOW = "2026-10-01T03:00:00.000Z";
const limit = (kind: string, label: string, percent: number, resetsAt: string | null): ClaudeLimit => ({ kind, label, percent, severity: "normal", resetsAt, active: kind === "session" });

function opsFixture(claude: OpsResponse["claude"]): OpsResponse {
  return {
    now: NOW,
    bridge: { connected: true },
    github: null,
    mac: { at: NOW, stale: false, volumes: [], load: { one: 1, five: 1, fifteen: 1, cpus: 8 }, memory: { freePct: 40, pressure: "normal" }, uptimeSec: 3600, runners: [], chatRunner: true },
    claude,
    flyAt: null,
    flyStale: false,
    flySource: null,
    healthStaleSince: null,
    apps: [],
    summary: { needs: 0, redCi: 1, failingSchedules: 0, appsDown: 0, disk: { freePct: 41, tone: "ok" } },
  } as unknown as OpsResponse;
}

const reading = (stale = false): OpsResponse["claude"] => ({
  at: "2026-10-01T02:58:00.000Z",
  stale,
  limits: [
    limit("session", "Session (5 hr)", 37.4, "2026-10-01T05:00:00.000Z"),
    limit("weekly_all", "Week (all models)", 62, "2026-10-03T03:00:00.000Z"),
    limit("weekly_scoped", "Week (Opus)", 20, null),
  ],
});

let root: HTMLElement;
const hero = (id: "claude" | "openai") => root.querySelector<HTMLElement>(`.usage-hero[data-section="${id}"]`)!;
/** The overall's two figures: used, from the line under the meter, then left, the lead figure. */
const figures = (id: "claude" | "openai") => [hero(id).querySelector(".usage-lines")!.textContent!.split(" used")[0], hero(id).querySelector(".reading-lead-n")!.textContent];
const lines = (id: "claude" | "openai") => hero(id).querySelector(".usage-lines")!.textContent;
const reset = (id: "claude" | "openai") => [...hero(id).querySelectorAll(".usage-reset > span")].map((n) => n.textContent);
const card = (id: string) => root.querySelector<HTMLElement>(`[data-section="${id}"]`)!;
const cards = (el: Element) => [...el.querySelectorAll<HTMLElement>(".cost-card")];
const names = (el: Element) => cards(el).map((row) => row.querySelector(".cost-name")!.textContent);
/** A Costs-style card's parts: name, figure, pill text and tone, the meta beside the pill, and the plain line. */
const parts = (row: Element) => {
  const pill = row.querySelector(".cost-pill")!;
  return {
    name: row.querySelector(".cost-name")!.textContent,
    figure: row.querySelector(".cost-figure")!.textContent || null,
    pill: pill.textContent,
    tone: ["yes", "warn", "bad", "quiet"].find((t) => pill.classList.contains(t)) ?? null,
    meta: row.querySelector(".cost-when")?.textContent ?? null,
    line: row.querySelector(".cost-line")?.textContent ?? null,
  };
};
/** A card's meter: its tone (or unread), how far it is filled, and what it says to a screen reader. */
const meter = (row: Element) => {
  const bar = row.querySelector(".cost-bar")!;
  return [bar.className.replace("cost-bar ", ""), (bar.firstElementChild as HTMLElement).style.width || null, bar.getAttribute("aria-label")];
};
/** The rows that light Machines' pill, each with its name, line and tone. */
const wrong = () => ops.wrongRows(opsData.ops, "machines").rows;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  localStorage.clear();
  root = document.createElement("div");
  document.body.replaceChildren(root);
  opsData.at = Date.now();
  opsData.opsAt = { mono: performance.now(), wall: Date.now() };
  app.tab = "progress";
  app.opsPage = "usage";
});

afterEach(() => {
  ops.unmount();
  opsData.ops = null;
  opsData.error = null;
  opsData.at = 0;
  document.documentElement.classList.remove("desktop");
  document.head.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Ops Usage page", () => {
  it("leads with overall Claude and overall OpenAI, then each provider's accounts", () => {
    const usage = reading()!;
    opsData.ops = opsFixture({
      ...usage,
      // Bridge order, not reset order: the accounts card sorts by next reset, rows without one last in bridge order.
      limits: [...usage.limits, limit("account_1", "Account aa*** (no reading)", 0, null), limit("account_2", "Account st*** (active)", 31, "2026-10-08T13:00:00.000Z"),
        limit("account_3", "Account zz*** (no reading)", 0, null), limit("account_4", "Account cm*** (5-hr 88%)", 51, "2026-10-05T11:00:00.000Z"),
        { ...limit("codex_1_week", "cm***, week (active)", 100, "2026-10-03T17:00:00.000Z"), severity: "critical", credits: 0, unlimited: false },
        { ...limit("codex_2_week", "ch***, week", 47, "2026-10-08T01:35:00.000Z"), credits: 61_900.4, unlimited: false },
      ],
    });
    ops.mount(root);
    expect([...root.querySelectorAll("[data-section]:not(.ops)")].map((sec) => sec.getAttribute("data-section"))).toEqual(["claude", "openai", "claude-accounts", "openai-accounts"]);

    // Claude: every account's week summed; two unread accounts keep their 100% in the total but nothing known left.
    expect(figures("claude")).toEqual(["0.8", "1.2+"]);
    expect(hero("claude").querySelector(".reading-lead-words")!.textContent).toBe("of 4 left");
    expect(lines("claude")).toBe("0.8 used · 2 accounts not read");
    expect(hero("claude").querySelector(".usage-hero-meta")!.textContent).toBe("4 accounts");
    // One cell per account, in the bridge's order; an unread one is hatched, never a 0% fill.
    expect([...hero("claude").querySelectorAll(".usage-cell")].map((c) => [c.classList.contains("unread"), c.querySelector<HTMLElement>(".usage-cell-fill")!.style.width])).toEqual([
      [true, ""],
      [false, "31%"],
      [true, ""],
      [false, "51%"],
    ]);
    expect(reset("claude")).toEqual(["Next reset", "Mon 10:00pm, in 4 days, 8h 0m", "cm***, 51% used"]);

    // OpenAI: each Codex account's week, summed the same way.
    expect(figures("openai")).toEqual(["1.5", "0.5"]);
    expect(hero("openai").querySelector(".reading-lead-words")!.textContent).toBe("of 2 left");
    // A quarter left is gold, and an account at 90% or over says so on a gold card.
    expect(hero("openai").classList.contains("t-warn")).toBe(true);
    expect(lines("openai")).toBe("1.5 used · 1 account full");
    expect(reset("openai")).toEqual(["Next reset", "Sun 4:00am, in 2 days, 14h 0m", "cm***, 100% used"]);

    const accounts = card("claude-accounts");
    const lists = accounts.querySelectorAll(".costs-list");
    expect(names(lists[0]!)).toEqual(["cm***", "st***", "aa***", "zz***"]);
    // An unread account reads "no reading", never "0%", with no reset; the notes are the plain line under the pill.
    expect(cards(lists[0]!).map(parts)).toEqual([
      { name: "cm***", figure: "51%", pill: "OK", tone: "yes", meta: "resets Mon 10:00pm, in 4 days, 8h 0m", line: "5-hr 88%" },
      { name: "st***", figure: "31%", pill: "OK", tone: "yes", meta: "resets Fri 12:00am, in 7 days, 10h 0m", line: "Active" },
      { name: "aa***", figure: "no reading", pill: "No reading", tone: "quiet", meta: "no reset time", line: null },
      { name: "zz***", figure: "no reading", pill: "No reading", tone: "quiet", meta: "no reset time", line: null },
    ]);
    expect(accounts.querySelector(".usage-sub")!.textContent).toBe("Signed-in account");
    expect(names(lists[1]!)).toEqual(["Session (5 hr)", "Week (all models)", "Week (Opus)"]);
    // Each account carries its meter, filled to its week in its grade; an unread account's is hatched, never an empty 0%. The signed-in account's meters have theirs.
    expect(cards(lists[0]!).map(meter)).toEqual([
      ["yes", "51%", "cm*** 51 percent used"],
      ["yes", "31%", "st*** 31 percent used"],
      ["unread", null, "aa***: no reading"],
      ["unread", null, "zz***: no reading"],
    ]);
    expect(cards(lists[1]!).map((row) => meter(row)[1])).toEqual(["37%", "62%", "20%"]);

    const openai = card("openai-accounts");
    expect(names(openai)).toEqual(["cm***", "ch***"]);
    expect(cards(openai).map((row) => [parts(row).figure, parts(row).meta, parts(row).tone, parts(row).line])).toEqual([
      ["100%", "resets Sun 4:00am, in 2 days, 14h 0m", "bad", "Active"],
      ["47%", "resets Thu 12:35pm, in 6 days, 22h 35m", "yes", null],
    ]);
    expect(cards(openai).map(meter)).toEqual([["bad", "100%", "cm*** 100 percent used"], ["yes", "47%", "ch*** 47 percent used"]]);
  });

  it("puts the overalls first, the details under them, and only on Usage", () => {
    opsData.ops = opsFixture(reading());
    ops.mount(root);
    // The Usage page is the overalls, then the details.
    const order = [...root.querySelectorAll(".ops .reading-figures > *")].map((el) => el.className.split(" ")[0]);
    expect(root.querySelector(".ops-pills")).toBeNull();
    expect(order.indexOf("usage-heroes")).toBeGreaterThan(-1);
    expect(order.indexOf("usage-heroes")).toBeLessThan(order.indexOf("ops-page-more"));
    // The detail folds under More.
    expect(root.querySelector(".ops-page-more > .ops-page-more-head")!.textContent).toBe("More");
    expect(root.querySelector(".ops-page-more .usage-more")).not.toBeNull();
    expect(hero("claude").classList.contains("box")).toBe(true);
    ops.unmount();
    app.tab = "progress";
    app.opsPage = "code";
    ops.mount(root);
    expect(root.querySelector(".usage-heroes")).toBeNull();
    expect(root.querySelector(".usage-more")).toBeNull();
  });

  it("sums every account's week raw, out of 100% each, never averaged, and grades it on the share of the total", () => {
    const accounts = (...pcts: number[]) => pcts.map((pct, i) => limit(`account_${i + 1}`, `Account a${i}***`, pct, `2026-10-0${5 + i}T11:00:00.000Z`));
    const four = accountsTotal(accounts(100, 98, 90, 80))!;
    expect(four).toMatchObject({ used: 368, total: 400, unread: 0, tone: "bad", resetsAt: "2026-10-05T11:00:00.000Z" });
    const three = accountsTotal(accounts(100, 98, 90))!;
    expect(three).toMatchObject({ used: 288, total: 300, tone: "bad" });
    // A full account counts as 100, however far over it reads.
    expect(accountsTotal(accounts(100, 0, 0))).toMatchObject({ used: 100, total: 300, tone: "ok" });
    expect(accountsTotal(accounts(130, 0, 0, 0))).toMatchObject({ used: 100, total: 400 });
    expect(accountsTotal(accounts(80, 80, 80, 80))!.tone).toBe("warn");
    expect(accountsTotal(accounts(79, 80, 80, 80))!.tone).toBe("ok");
    expect(accountsTotal(accounts(90, 90, 90))!.tone).toBe("bad");
    // An unread account, none or an old reading, still has its 100% in the total, and adds nothing used.
    const unread = accountsTotal([...accounts(50, 50, 50), limit("account_4", "Account zz*** (no reading)", 0, null)])!;
    expect(unread).toMatchObject({ used: 150, total: 400, unread: 1, tone: "ok" });
    const old = accountsTotal([...accounts(95, 95, 95), limit("account_4", "Account zz*** (old, 5-hr 90%)", 99, "2026-10-05T11:00:00.000Z")])!;
    expect(old).toMatchObject({ used: 285, total: 400, unread: 1, tone: "bad" });
    expect(accountsTotal(reading()!.limits)).toBeNull();
  });

  it("sums the Codex accounts the same way, each on its longest window, with an unread one in the total", () => {
    const rows: ClaudeLimit[] = [
      limit("codex_1_5hr", "cm***, 5 hr (active)", 40, "2026-10-01T05:00:00.000Z"),
      { ...limit("codex_1_week", "cm***, week (active)", 90, "2026-10-04T05:00:00.000Z"), severity: "warning", credits: null, unlimited: true },
      limit("codex_2", "ch*** (no reading)", 0, null),
    ];
    const cells = codexCells([...reading()!.limits, ...rows]);
    expect(cells.map((cell) => [cell.who, cell.percent, cell.window, cell.active, cell.unread])).toEqual([
      ["cm***", 90, "week", true, false],
      ["ch***", 0, "week", false, true],
    ]);
    expect(sumCells(cells)).toMatchObject({ used: 90, total: 200, unread: 1, tone: "bad", resetsAt: "2026-10-04T05:00:00.000Z" });
    expect(sumCells(cells)!.next!.who).toBe("cm***");
    expect(sumCells(codexCells([rows[2]!]))).toBeNull();
    // The last account of a full reading (12 rows) whose week the cap cut is not read: its 5-hour window never stands
    // in for the week. Short of the cap, a row without credits fields (an older bridge) is still that account's reading.
    const tail = limit("codex_3_5hr", "zz***, 5 hr", 5, "2026-10-01T05:00:00.000Z");
    const pad = Array.from({ length: 8 }, (_, i) => limit(`account_${i + 1}`, `Account a${i}*** (no reading)`, 0, null));
    expect(pad.length + rows.length + 1).toBe(MAX_CLAUDE_LIMITS);
    const cut = codexCells([...pad, ...rows, tail]);
    expect(cut.map((cell) => [cell.who, cell.unread])).toEqual([["cm***", false], ["ch***", true], ["zz***", true]]);
    expect(sumCells(cut)).toMatchObject({ used: 90, total: 300, unread: 2 });
    expect(codexCells([...rows, tail]).map((cell) => [cell.who, cell.unread])).toEqual([["cm***", false], ["ch***", true], ["zz***", false]]);

    opsData.ops = opsFixture({ ...reading()!, limits: [...reading()!.limits, ...rows] });
    ops.mount(root);
    expect(figures("openai")).toEqual(["0.9", "0.1+"]);
    expect(lines("openai")).toBe("0.9 used · 1 account not read · 1 account full");
    // The shorter window rides under the account's row.
    expect(parts(cards(card("openai-accounts"))[0]!)).toEqual({ name: "cm***", figure: "90%", pill: "High", tone: "warn", meta: "resets Sun 4:00pm, in 3 days, 2h 0m", line: "Active · 5 hr 40% · resets 4:00pm, in 2h 0m" });
    ops.unmount();
    // A full shorter window keeps its red under a calm week.
    const full = [{ ...rows[0]!, percent: 100, severity: "critical" as const }, { ...rows[1]!, percent: 10, severity: "normal" as const }];
    opsData.ops = opsFixture({ ...reading()!, limits: [...reading()!.limits, ...full] });
    ops.mount(root);
    expect(parts(cards(card("openai-accounts"))[0]!)).toMatchObject({ figure: "10%", tone: "bad", line: "Active · 5 hr 100% · resets 4:00pm, in 2h 0m" });
    // The meter is the week's own: calm at 10%, while the pill counts the full 5 hours.
    expect(meter(cards(card("openai-accounts"))[0]!)).toEqual(["yes", "10%", "cm*** 10 percent used"]);
    ops.unmount();
    // A freshly reset account reads 0% and its meter is empty, as its overall cell is.
    opsData.ops = opsFixture({ ...reading()!, limits: [...reading()!.limits, limit("account_1", "Account fr***", 0, "2026-10-05T11:00:00.000Z")] });
    ops.mount(root);
    expect(meter(cards(card("claude-accounts"))[0]!)).toEqual(["yes", "0%", "fr*** 0 percent used"]);
  });

  it("shows a limited account at 100% with its reset, and an idle or stale row's figure with its age, never no reading", () => {
    const resets = "2026-10-02T13:00:00.000Z";
    const rows = gradeAccounts([
      limit("account_1", "Account st*** (limited, 2 hr old)", 100, resets),
      limit("account_2", "Account ch*** (33 hr old)", 4, "2026-10-05T13:00:00.000Z"),
      limit("account_3", "Account cm*** (active)", 3, "2026-10-05T11:00:00.000Z"),
    ]);
    opsData.ops = opsFixture({ at: "2026-10-01T02:58:00.000Z", stale: false, limits: rows });
    ops.mount(root);
    expect(figures("claude")).toEqual(["1.1", "1.9"]);
    expect(hero("claude").textContent).not.toContain("not read");
    const shown = cards(card("claude-accounts")).map(parts);
    expect(shown.find((row) => row.name === "st***")).toMatchObject({ figure: "100%", pill: "Very high", line: "Limited · 2 hr old" });
    expect(shown.find((row) => row.name === "st***")?.meta).toContain("resets");
    expect(shown.find((row) => row.name === "ch***")).toMatchObject({ figure: "4%", line: "33 hr old" });
  });

  it("leads the week with every account's total out of 400%, an unread one said, and grades rows from the percentage", () => {
    const week = limit("weekly_all", "Week (all models)", 89.6, null);
    const rows = [100, 98, 90, 13].map((pct, i) => limit(`account_${i + 1}`, `Account a${i}***`, pct, null));
    expect(ops.weekTotal([week, ...rows])).toEqual({ text: "3 of 4 weekly limits used", used: "3 of 4 weekly limits used", unread: null, tone: "ok", n: "3", of: "of 4" });
    expect(ops.weekTotal([week, ...rows.slice(0, 3), limit("account_4", "Account sp*** (no reading)", 0, null)])).toEqual({
      text: "2.9 of 4 weekly limits used, 1 account not read",
      used: "2.9 of 4 weekly limits used",
      unread: "1 account not read",
      tone: "bad",
      n: "2.9",
      of: "of 4",
    });
    // With no account read, this account's own week, standing in for one of them as on Usage's overall.
    expect(ops.weekTotal([week, limit("account_2", "Account sp*** (old)", 99, null)])).toMatchObject({ text: "0.9 of 1 weekly limit used", tone: "ok" });
    expect(ops.weekTotal([week, limit("account_2", "Account sp*** (old)", 99, null), limit("account_3", "Account aa*** (no reading)", 0, null)])).toMatchObject({
      text: "0.9 of 2 weekly limits used, 1 account not read",
      of: "of 2",
    });
    expect(ops.weekTotal([week])).toMatchObject({ text: "0.9 of 1 weekly limit used", tone: "ok" });
    // The overall is graded on the total, not on this account's own week or the worst account: 3 of 4 is 75%, calm.
    const own = reading()!.limits.map((row) => (row.kind === "weekly_all" ? { ...row, percent: 100, severity: "critical" as const } : row));
    opsData.ops = opsFixture({ ...reading()!, limits: [...own, ...gradeAccounts(rows)] });
    ops.mount(root);
    expect(figures("claude")).toEqual(["3", "1"]);
    // A quarter left is gold, the figure and the card both.
    expect(hero("claude").classList.contains("t-warn")).toBe(true);
    expect(hero("claude").querySelector(".reading-lead")!.classList.contains("t-warn")).toBe(true);
    ops.unmount();
    expect(ops.weekTotal([])).toBeNull();
    // An older bridge graded every account row normal; the server grades it from its week.
    const graded = gradeAccounts([{ ...limit("account_1", "Account cm***", 100, null), severity: "normal" }, limit("account_2", "Account ch***", 85, null), limit("account_3", "Account st*** (old)", 99, null), week]);
    expect(graded.map((row) => row.severity)).toEqual(["critical", "warning", "normal", week.severity]);

    // With no account read, the overall is this account's own week, out of one limit.
    opsData.ops = opsFixture({ ...reading()!, limits: [...reading()!.limits, limit("account_1", "Account st*** (active, old, 5-hr 88%)", 99, "2026-10-05T11:00:00.000Z")] });
    ops.mount(root);
    expect(figures("claude")).toEqual(["0.6", "0.4"]);
    expect(lines("claude")).toBe("0.6 used");
    expect(parts(cards(card("claude-accounts"))[0]!)).toMatchObject({ name: "st***", figure: "no reading", line: "Active · 5-hr 88%" });
    ops.unmount();

    // The other accounts stay in the total, not read, beside the signed-in account's own week.
    opsData.ops = opsFixture({
      ...reading()!,
      limits: [...reading()!.limits, limit("account_1", "Account st*** (active, old)", 99, null), ...["aa", "bb", "cc"].map((who, i) => limit(`account_${i + 2}`, `Account ${who}*** (no reading)`, 0, null))],
    });
    ops.mount(root);
    expect(figures("claude")).toEqual(["0.6", "0.4+"]);
    expect(hero("claude").querySelector(".reading-lead-words")!.textContent).toBe("of 4 left");
    expect(lines("claude")).toBe("0.6 used · 3 accounts not read");
    expect(reset("claude")[2]).toBe("st***, 62% used");
    ops.unmount();

    // With none marked active, the own week still stands in for one of the four, never a fifth beside them.
    opsData.ops = opsFixture({ ...reading()!, limits: [...reading()!.limits, ...["st", "aa", "bb", "cc"].map((who, i) => limit(`account_${i + 1}`, `Account ${who}*** (no reading)`, 0, null))] });
    ops.mount(root);
    expect(hero("claude").querySelector(".reading-lead-words")!.textContent).toBe("of 4 left");
    expect(lines("claude")).toBe("0.6 used · 3 accounts not read");
    expect(hero("claude").querySelector(".usage-hero-meta")!.textContent).toBe("4 accounts");
  });

  it("says the overall in limits, used and left, fills each account's cell and names the next reset; a stale one says how old", () => {
    const rows = [100, 98, 90, 80].map((pct, i) => limit(`account_${i + 1}`, `Account a${i}***`, pct, `2026-10-0${5 + i}T11:00:00.000Z`));
    opsData.ops = opsFixture({ ...reading()!, limits: [...reading()!.limits, ...rows] });
    ops.mount(root);
    expect(figures("claude")).toEqual(["3.7", "0.3"]);
    expect(lines("claude")).toBe("3.7 used · 3 accounts full");
    expect([...hero("claude").querySelectorAll<HTMLElement>(".usage-cell-fill")].map((f) => f.style.width)).toEqual(["100%", "98%", "90%", "80%"]);
    expect(hero("claude").querySelector(".usage-cells")!.getAttribute("aria-label")).toBe("Claude: 0.3 of 4 left, 3.7 used · 3 accounts full");
    expect(reset("claude")).toEqual(["Next reset", "Mon 10:00pm, in 4 days, 8h 0m", "a0***, 100% used"]);
    expect(hero("claude").classList.contains("t-bad")).toBe(true);
    ops.unmount();

    opsData.ops = opsFixture({ ...reading(true)!, limits: [...reading()!.limits, ...rows.slice(0, 3)] });
    ops.mount(root);
    expect(figures("claude")).toEqual(["2.9", "0.1"]);
    expect(hero("claude").querySelector(".usage-hero-meta")!.textContent).toMatch(/^Read /);
    expect(hero("claude").querySelector(".usage-hero-meta")!.classList.contains("t-warn")).toBe(true);
  });

  it("adds no Machines row for a Mac with room", () => {
    opsData.opsAt = { mono: performance.now(), wall: Date.now() };
    app.tab = "progress";
    app.opsPage = "machines";
    opsData.ops = { ...opsFixture(reading()), summary: { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 0, disk: { freePct: 28.4, tone: "ok" } } };
    ops.mount(root);
    expect(wrong()).toEqual([]);
    // Nothing wrong, but GitHub has not been read: nothing that reads as All clear.
    expect(root.textContent).not.toContain("All clear");
  });

  it("shows an old Mac reading as no reading: no disk row, and the Mac says when it was read", () => {
    const old = "2026-10-01T02:50:00.000Z";
    const fixture = opsFixture(reading());
    const volume = { label: "Macintosh HD", freeBytes: 3, totalBytes: 100, runners: true };
    opsData.ops = { ...fixture, mac: { ...fixture.mac!, at: old, volumes: [volume] }, summary: { ...fixture.summary, disk: { freePct: 3, tone: "bad" } } };
    app.tab = "progress";
    app.opsPage = "machines";
    ops.mount(root);
    expect(wrong()).toEqual([]);
    ops.unmount();
    app.opsPage = "machines";
    ops.mount(root);
    const line = root.querySelector<HTMLElement>('[data-section="mac"] .ops-sec-line')!;
    expect(line.textContent).toBe(`no reading since ${when(old)}`);
    expect(line.classList.contains("t-warn")).toBe(true);
    ops.unmount();
    // A reading the server stamped now ages on this device's clock once the answers stop.
    opsData.ops = { ...fixture, mac: { ...fixture.mac!, volumes: [volume] }, summary: { ...fixture.summary, disk: { freePct: 3, tone: "bad" } } };
    app.opsPage = "machines";
    ops.mount(root);
    expect(wrong().map((row) => [row.title, row.line])).toEqual([
      ["Mac Macintosh HD disk", "3% free · the runners' work directories"],
    ]);
    ops.unmount();
    opsData.opsAt = { mono: performance.now() - 6 * 60_000, wall: Date.now() };
    ops.mount(root);
    expect(wrong()).toEqual([]);
  });

  it("ages apps and GitHub on the clock since Ops answered, not on the server's stamps", () => {
    const fixture = { ...opsFixture(reading()), github: { at: NOW, stale: false, prs: [], sources: null } } as unknown as OpsResponse;
    expect([healthCurrent(fixture), githubCurrent(fixture), macCurrent(fixture)]).toEqual([true, true, true]);
    opsData.opsAt = { mono: performance.now() - 6 * 60_000, wall: Date.now() };
    expect([healthCurrent(fixture), githubCurrent(fixture), macCurrent(fixture)]).toEqual([true, false, false]);
    opsData.opsAt = { mono: performance.now() - 16 * 60_000, wall: Date.now() };
    expect(healthCurrent(fixture)).toBe(false);
  });

  it("shows the Usage page's no-reading state instead of numbers, and the age of a stale reading", () => {
    opsData.ops = opsFixture(null);
    ops.mount(root);
    expect(hero("claude").querySelector(".usage-hero-empty")!.textContent).toBe("No Claude usage read yet.");
    expect(hero("openai").querySelector(".usage-hero-empty")!.textContent).toBe("No OpenAI accounts read yet.");
    expect(root.querySelector(".usage-heroes")!.textContent).not.toMatch(/\d/);
    expect(root.querySelector('[data-section="claude-accounts"]')).toBeNull();
    ops.unmount();

    opsData.ops = opsFixture(reading(true));
    ops.mount(root);
    expect(hero("claude").classList.contains("t-warn")).toBe(true);
    expect(figures("claude")).toEqual(["0.6", "0.4"]);
    expect(hero("claude").querySelector(".usage-hero-meta")!.textContent).toMatch(/^Read /);
  });

  it("goes stale by the clock once a cached reading outlives the Usage threshold while /api/ops fails", async () => {
    opsData.ops = opsFixture({ ...reading()!, limits: [...reading()!.limits, { ...limit("codex_1_week", "cm***, week", 20, null), credits: null, unlimited: false }] });
    ops.mount(root);
    expect(hero("claude").classList.contains("t-ok")).toBe(true);
    expect(hero("claude").textContent).not.toContain("Read ");
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "down" }, 503)));
    vi.setSystemTime(Date.parse(NOW) + 9 * 60_000);
    await refreshOps();
    expect(opsData.ops!.claude!.stale).toBe(false);
    expect(hero("claude").classList.contains("t-warn")).toBe(true);
    expect(hero("claude").querySelector(".usage-hero-meta")!.textContent).toMatch(/^Read (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m$/);
    expect([...root.querySelectorAll(".ops-notice")].map((n) => n.textContent)).toContainEqual(expect.stringMatching(/^Claude usage is from (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m\.$/));
    // Codex rides on the Claude reading and may be older than it, so its time is the latest it can be.
    expect(hero("openai").querySelector(".usage-hero-meta")!.textContent).toMatch(/^Read (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m or earlier$/);
  });

  it("repaints mounted Claude usage at expiry while the next poll hangs", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fixture = opsFixture({ ...reading()!, at: "2026-10-01T02:50:01.000Z" });
    let initial = true;
    let release!: () => void;
    const hanging = new Promise<Response>((resolve) => { release = () => resolve(json({ error: "down" }, 503)); });
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      if (!initial && path === "/api/ops") return hanging;
      return Promise.resolve(json(path === "/api/ops" ? fixture : path === "/api/ops/timeline" ? { events: [] } : path === "/api/ops/statuses" ? { statuses: [] } : { briefing: null }));
    }));
    await refreshOps();
    ops.mount(root);
    expect(hero("claude").classList.contains("t-ok")).toBe(true);
    initial = false;
    const pending = refreshOps();
    try {
      await vi.advanceTimersByTimeAsync(1_050);
      expect(hero("claude").classList.contains("t-warn")).toBe(true);
      expect(hero("claude").querySelector(".usage-hero-meta")!.textContent).toMatch(/^Read (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m$/);
    } finally {
      ops.unmount();
      release();
      await pending;
    }
  });

  it.each([-3_600_000, 3_600_000])("uses server age for attached usage with a device clock offset of %s ms", (offset) => {
    vi.setSystemTime(Date.parse(NOW) + offset);
    opsData.at = Date.now();
    opsData.opsAt = { mono: performance.now(), wall: Date.now() };
    opsData.ops = opsFixture(reading());
    expect(ops.usageStale(opsData.ops.claude!)).toBe(false);
    ops.mount(root);
    expect(hero("claude").classList.contains("t-ok")).toBe(true);
    ops.unmount();

    // Wall time goes backwards while monotonic time advances past the remaining eight minutes.
    vi.setSystemTime(Date.now() - 3_600_000);
    opsData.opsAt.mono = performance.now() - 9 * 60_000;
    expect(ops.usageStale(opsData.ops.claude!)).toBe(true);
    ops.mount(root);
    expect(hero("claude").classList.contains("t-warn")).toBe(true);
    expect(hero("claude").querySelector(".usage-hero-meta")!.textContent).toMatch(/^Read (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m$/);
    expect(root.textContent).toMatch(/Claude usage is from (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m\./);
    expect(card("claude-accounts").querySelector(".usage-card-meta")!.textContent).toMatch(/^Read (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m$/);
  });
});

describe("Ops Refresh", () => {
  it("reloads once however often it is clicked, busy and disabled until the load ends", async () => {
    opsData.ops = opsFixture(reading());
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        await gate;
        return new Response(JSON.stringify({ error: "no" }), { status: 500, headers: { "content-type": "application/json" } });
      }),
    );
    ops.mount(root);
    const first = root.querySelector<HTMLButtonElement>(".reading-btn")!;
    expect(first.textContent).toBe("Refresh");
    first.click();
    first.click();
    const busy = root.querySelector<HTMLButtonElement>(".reading-btn")!;
    busy.click();
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toBe("Refreshing…");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(calls.filter((url) => url === "/api/ops")).toHaveLength(1);
    expect(calls.filter((url) => url === "/api/board")).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>(".reading-btn")!.disabled).toBe(false));
    expect(root.querySelector(".reading-btn")!.textContent).toBe("Refresh");
    // The last figures stay under one plain line, never the server's own words.
    expect(root.querySelector(".reading-stale")!.textContent).toBe("Couldn't refresh. These are the last numbers read.");
    expect(root.querySelector(".usage-hero")).not.toBeNull();
    expect(root.textContent).not.toMatch(/Request failed/);
  });

  it("gives up waiting after 20 seconds: the button frees and the error notice shows", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: new Date(NOW) });
    const answers: (() => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => answers.push(() => resolve(json({ error: "late" }, 500))))));
    opsData.ops = opsFixture(reading());
    ops.mount(root);
    const button = () => root.querySelector<HTMLButtonElement>(".reading-btn")!;
    button().click();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(button().disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe("Refresh");
    expect(root.querySelector(".reading-stale")!.textContent).toBe("Couldn't refresh. These are the last numbers read.");
    for (const answer of answers) answer();
    await refreshOps();
  });

  it("says when the figures were read, with Refresh, on a phone as on a desktop", () => {
    opsData.ops = opsFixture(reading());
    opsData.opsAt = { mono: performance.now(), wall: Date.parse(NOW) };
    ops.mount(root);
    expect(root.querySelector(".reading-at")!.textContent).toBe(`Updated ${clock(Date.parse(NOW))}`);
    expect(root.querySelector(".reading-btn")!.textContent).toBe("Refresh");
  });
});
