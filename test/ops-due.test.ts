import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error the CLI is plain ESM without type declarations
import { run } from "../scripts/rivet.mjs";
import { dueLabel, parseDue } from "../src/shared/ops-due.js";
import type { OpsStatus, OpsStatusResponse } from "../src/shared/ops-status.js";
import { setTimeZone } from "../src/shared/when.js";
import { bearer, BOARD_TOKEN, fakeClock, startServer, type TestServer } from "./helpers.js";

// Noon Saturday 24 October 2026 local time (+11).
const NOON = new Date("2026-10-24T01:00:00.000Z");

describe("a done-by time read in local time", () => {
  const due = (eta: string, now = NOON, monitor = false) => {
    const read = parseDue(eta, now, monitor);
    return "dueAt" in read ? read.dueAt : read.error;
  };

  it("reads minutes, hours, a clock time and tonight", () => {
    expect(due("90")).toBe("2026-10-24T02:30:00.000Z");
    expect(due("90m")).toBe("2026-10-24T02:30:00.000Z");
    expect(due("2h")).toBe("2026-10-24T03:00:00.000Z");
    expect(due("3pm")).toBe("2026-10-24T04:00:00.000Z");
    expect(due("3:30pm")).toBe("2026-10-24T04:30:00.000Z");
    expect(due("3:30 PM")).toBe("2026-10-24T04:30:00.000Z");
    expect(due("15:30")).toBe("2026-10-24T04:30:00.000Z");
    expect(due("by 3pm")).toBe("2026-10-24T04:00:00.000Z");
    expect(due("today 18:00")).toBe("2026-10-24T07:00:00.000Z");
    expect(due("tonight")).toBe("2026-10-24T12:00:00.000Z");
    expect(due("12am")).toBe("2026-10-24T13:00:00.000Z");
    expect(due("2026-10-24T16:00:00+11:00")).toBe("2026-10-24T05:00:00.000Z");
  });

  it("takes a clock time already past as tomorrow's", () => {
    expect(due("11am")).toBe("2026-10-25T00:00:00.000Z");
    expect(due("12pm")).toBe("2026-10-25T01:00:00.000Z");
  });

  describe("in a zone with daylight time", () => {
    beforeEach(() => setTimeZone("Pacific/Auckland"));
    afterEach(() => setTimeZone(undefined));

    it("reads standard time in winter and crosses the change to daylight time", () => {
      expect(due("3pm", new Date("2026-06-15T02:00:00.000Z"))).toBe("2026-06-15T03:00:00.000Z");
      // 10pm Saturday 26 September, standard time; clocks go forward at 2am Sunday.
      expect(due("9am", new Date("2026-09-26T10:00:00.000Z"))).toBe("2026-09-26T20:00:00.000Z");
      // 10pm Saturday 4 April, daylight time; clocks go back at 3am Sunday.
      expect(due("9am", new Date("2026-04-04T09:00:00.000Z"))).toBe("2026-04-04T21:00:00.000Z");
    });

    it("refuses a local time the clocks skip as they go forward", () => {
      const gap = "eta names a time that does not exist: the clocks go forward an hour that night";
      // 1am Sunday 27 September, standard time: 2am goes straight to 3am.
      const night = new Date("2026-09-26T13:00:00.000Z");
      for (const eta of ["2:30am", "2am", "02:59"]) expect(due(eta, night), eta).toBe(gap);
      expect(due("3am", night)).toBe("2026-09-26T14:00:00.000Z");
      expect(due("1:30am", night)).toBe("2026-09-26T13:30:00.000Z");
      // Read the evening before, 2:30am is still the skipped one.
      expect(due("2:30am", new Date("2026-09-26T12:00:00.000Z"))).toBe(gap);
      expect(due("2:30am", new Date("2026-09-26T11:00:00.000Z"))).toBe(gap);
    });
  });

  it("refuses a time it cannot read, one not ahead, and one over a day out unless the monitor sets it", () => {
    for (const eta of ["soon", "", "13pm", "24:00", "next week", "2026-10-24"]) expect(due(eta), eta).toMatch(/^eta is minutes/);
    expect(due("0")).toBe("eta must be ahead of now");
    expect(due("2026-10-24T00:00:00Z")).toBe("eta must be ahead of now");
    expect(due("25h")).toMatch(/^eta is at most 24 hours out/);
    expect(due("24h")).toBe("2026-10-25T01:00:00.000Z");
    expect(due("25h", NOON, true)).toBe("2026-10-25T02:00:00.000Z");
    expect(due("169h", NOON, true)).toBe("eta is at most 7 days out");
  });

  it("labels a done-by as the app shows it", () => {
    expect(dueLabel("2026-10-24T04:30:00.000Z", NOON)).toBe("by 3:30pm");
    expect(dueLabel("2026-10-24T04:00:00.000Z", NOON)).toBe("by 3:00pm");
    expect(dueLabel("2026-10-25T00:00:00.000Z", NOON)).toBe("by Sun 11:00am");
  });
});

describe("work under way says when it will be done and why", () => {
  let server: TestServer;
  let clock: ReturnType<typeof fakeClock>;

  beforeEach(async () => {
    clock = fakeClock(NOON.getTime());
    server = await startServer({ RIVET_MONITOR_CHAT: "monitor" }, { now: clock.now });
  });

  afterEach(async () => {
    await server.close();
  });

  const put = (path: string, body: Record<string, unknown>) =>
    fetch(`${server.base}/api/ops/status/${path}`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });
  const list = async () => ((await (await fetch(`${server.base}/api/ops/status`, { headers: bearer(BOARD_TOKEN) })).json()) as OpsStatusResponse).statuses;

  it("refuses investigating or in-progress without a readable eta and a why of at most 140", async () => {
    for (const state of ["investigating", "in-progress"]) {
      for (const body of [
        { state },
        { state, eta: "3pm" },
        { state, why: "rerun queued" },
        { state, eta: "soon", why: "rerun queued" },
        { state, eta: "25h", why: "rerun queued", by: "ci-fix" },
        { state, eta: "3pm", why: "x".repeat(141) },
        { state, eta: "3pm", why: "two\nlines" },
        { state, eta: "3pm", why: "rerun", askedForTimeAt: NOON.toISOString() },
        { state, eta: "3pm", why: "rerun", dueAt: NOON.toISOString() },
      ]) {
        expect((await put("ci/ci", body)).status, JSON.stringify(body)).toBe(400);
      }
    }
    expect(await list()).toEqual([]);
  });

  it("refuses with 400 a done-by in the hour the clocks skip, saying so", async () => {
    setTimeZone("Pacific/Auckland");
    try {
      clock.advance(Date.parse("2026-09-26T12:00:00.000Z") - NOON.getTime());
      const res = await put("ci/ci", { state: "investigating", eta: "2:30am", why: "rerun queued" });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/does not exist/);
      expect(await list()).toEqual([]);
    } finally {
      setTimeZone(undefined);
    }
  });

  it("keeps the done-by as dueAt with its label, takes a later one from the monitor, and drops it once work stops", async () => {
    const on = await put("ci/ci", { state: "in-progress", eta: "3:30pm", why: "waiting on a rerun", chat: "ci-fix" });
    expect(on.status).toBe(201);
    expect(await on.json()).toMatchObject({ state: "in-progress", dueAt: "2026-10-24T04:30:00.000Z", eta: "by 3:30pm", why: "waiting on a rerun" });
    const later = await put("ci/ci", { state: "in-progress", eta: "48h", why: "needs the weekend", by: "monitor" });
    expect(later.status).toBe(200);
    expect(await later.json()).toMatchObject({ dueAt: "2026-10-26T01:00:00.000Z", eta: "by Mon 12:00pm" });
    const parked = await put("ci/ci", { state: "backlog" });
    expect(parked.status).toBe(200);
    const record = (await parked.json()) as OpsStatus;
    expect(record).not.toHaveProperty("dueAt");
    expect(record).not.toHaveProperty("eta");
    expect(record).not.toHaveProperty("askedForTimeAt");
  });

  it("keeps a Coming item's start working with a done-by", async () => {
    expect((await put("coming/slow-sync", { state: "in-progress", eta: "tonight", why: "building it" })).status).toBe(201);
    expect((await list())[0]).toMatchObject({ kind: "coming", dueAt: "2026-10-24T12:00:00.000Z", why: "building it" });
  });

  it("rivet status set --eta and --why store dueAt and why end to end", async () => {
    let stderr = "";
    const env = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: BOARD_TOKEN, RIVET_URL: server.base, PATH: "" };
    const cli = (argv: string[]): Promise<number> => run(argv, { env, stdout: () => undefined, stderr: (s: string) => void (stderr += s) });
    expect(await cli(["status", "set", "ci", "ci", "--state", "investigating", "--eta", "3pm", "--why", "flaky test, rerun queued", "--chat", "ci-fix"]), stderr).toBe(0);
    expect((await list())[0]).toMatchObject({ state: "investigating", dueAt: "2026-10-24T04:00:00.000Z", why: "flaky test, rerun queued", chat: "ci-fix" });
    // A new time and its cause, as a chat asked why it is late answers.
    expect(await cli(["status", "set", "ci", "ci", "--state", "in-progress", "--eta", "4:30pm", "--why", "the rerun hit the same flake"]), stderr).toBe(0);
    expect((await list())[0]).toMatchObject({ state: "in-progress", dueAt: "2026-10-24T05:30:00.000Z", eta: "by 4:30pm", why: "the rerun hit the same flake" });
    expect(await cli(["status", "set", "ci", "ci", "--state", "in-progress"])).toBe(2);
    expect(stderr).toMatch(/--state in-progress needs --eta/);
  });
});
