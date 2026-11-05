import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dismissMark, MAX_OPS_DISMISS_MARK, MAX_OPS_DISMISSALS, OPS_DISMISS_DAYS, type OpsDismissal, type OpsDismissalsResponse } from "../src/shared/ops-dismiss.js";
import { jobScheduleKey, type JobSpec } from "../src/shared/jobs.js";
import { opsStatusKey } from "../src/shared/ops-status-key.js";
import { SchedulesStore } from "../src/server/schedules.js";
import { writeOpsStatus } from "../src/server/routes/ops-status.js";
import { pickupAsk } from "../src/server/asks/made.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, fakeClock, startServer, type TestServer } from "./helpers.js";

// Sam's Dismiss on a red Ops item.

const START = Date.parse("2026-10-24T00:00:00.000Z");

let server: TestServer;
let cookie: string;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  clock = fakeClock(START);
  server = await startServer({}, { now: clock.now });
  cookie = server.cookie();
});

afterEach(async () => {
  await server.close();
});

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = browser(cookie)): Promise<Response> {
  return fetch(`${server.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

const mark = (title: string, ...what: string[]) => dismissMark({ since: "2026-10-23T22:00:00.000Z", title, what });
const dismiss = (path: string, body: unknown = { mark: mark("Notes App", "down") }, headers?: Record<string, string>) => send("PUT", `/api/ops/dismissals/${path}`, body, headers);

async function list(headers: Record<string, string> = browser(cookie)): Promise<OpsDismissal[]> {
  const response = await send("GET", "/api/ops/dismissals", undefined, headers);
  expect(response.status).toBe(200);
  return ((await response.json()) as OpsDismissalsResponse).dismissals;
}

describe("ops dismissals", () => {
  it("stores a dismissal with its mark, changes it in place, and takes it back", async () => {
    const first = await dismiss("app/notes-app");
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ kind: "app", key: "notes-app", mark: mark("Notes App", "down"), at: "2026-10-24T00:00:00.000Z" });
    clock.advance(60_000);
    expect((await dismiss("app/notes-app", { mark: mark("Notes App", "down", "502") })).status).toBe(200);
    expect(await list()).toEqual([{ kind: "app", key: "notes-app", mark: mark("Notes App", "down", "502"), at: "2026-10-24T00:01:00.000Z" }]);
    // Rivet reads them with its token.
    expect(await list(bearer(BOARD_TOKEN))).toHaveLength(1);
    expect((await send("DELETE", "/api/ops/dismissals/app/notes-app")).status).toBe(200);
    expect((await send("DELETE", "/api/ops/dismissals/app/notes-app")).status).toBe(404);
    expect(await list()).toEqual([]);
  });

  it("parks the open pick-up ask of a break it dismisses that has no record, as nothing else can finish it", async () => {
    const at = new Date(clock.now());
    const bare = pickupAsk(server.app.store, { kind: "app", key: "notes-app" }, at, 30)!;
    const held = pickupAsk(server.app.store, { kind: "app", key: "tasks-app" }, at, 30)!;
    expect(writeOpsStatus(server.app.store, "app", "tasks-app", { state: "backlog", by: "rivet" }, null, at.toISOString()).code).toBe(201);
    expect((await dismiss("app/notes-app")).status).toBe(201);
    expect((await dismiss("app/tasks-app", { mark: mark("Tasks App", "down") })).status).toBe(201);
    expect(server.app.store.getAsk(bare.id)?.stage).toBe("parked");
    // One with a record is the record's to settle.
    expect(server.app.store.getAsk(held.id)?.stage).toBe("building");
    // Undo or Bring back opens the ask the dismissal parked again.
    expect((await send("DELETE", "/api/ops/dismissals/app/notes-app")).status).toBe(200);
    expect(server.app.store.getAsk(bare.id)).toMatchObject({ stage: "building" });
    expect(server.app.store.getAsk(bare.id)?.why).toBeUndefined();
    expect((await send("DELETE", "/api/ops/dismissals/app/tasks-app")).status).toBe(200);
    expect(server.app.store.getAsk(held.id)?.stage).toBe("building");
  });

  it("dismisses one of Sam's red jobs by its schedule key", async () => {
    const jobs = new SchedulesStore(server.dataDir);
    const at = clock.now();
    const spec = (name: string): JobSpec => ({ name, words: `check ${name} is up`, kind: "check", check: { probe: "up", app: "notes-app", where: "mac", onRed: "card" }, when: { every: "day", at: "07:00" }, cards: "red" });
    const red = (id: string, line: string) => {
      expect(jobs.jobs.create(id, spec(id), at)).toEqual({ ok: true });
      const begun = jobs.jobs.start(id, { run: `run-${id}-abcdefgh`, state: "start" }, at);
      if (!begun?.go) throw new Error("did not start");
      jobs.jobs.finish(id, { run: begun.run, state: "red", line }, at);
    };
    try {
      red("j-aaaaaaaa", "notes-app answered 503");
      red("j-bbbbbbbb", "tasks-app answered 503");
      const key = (id: string) => opsStatusKey("schedule", jobScheduleKey(id));
      // Each red job knows when its red streak began, so the phone's mark holds for that streak.
      expect(jobs.jobs.list(at).jobs.map((job) => job.redSince)).toEqual([at.toISOString(), at.toISOString()]);
      expect((await dismiss(`schedule/${key("j-aaaaaaaa")}`, { mark: mark("j-aaaaaaaa", "check j-aaaaaaaa is up") })).status).toBe(201);
    } finally {
      jobs.close();
    }
  });

  it("keeps a long red streak's start and its runs past the sweep, and lets a red before the newest green go", async () => {
    const jobs = new SchedulesStore(server.dataDir);
    const spec = (name: string): JobSpec => ({ name, words: `check ${name} is up`, kind: "check", check: { probe: "up", app: "notes-app", where: "mac", onRed: "card" }, when: { every: "day", at: "07:00" }, cards: "red" });
    let n = 0;
    const run = (id: string, at: Date, end?: { state: "red" | "green"; line?: string; log?: string[] }) => {
      const begun = jobs.jobs.start(id, { run: `run-${String(++n).padStart(4, "0")}-abcdefgh`, state: "start" }, at);
      if (!begun?.go) throw new Error("did not start");
      if (end) jobs.jobs.finish(id, { run: begun.run, ...end }, at);
    };
    const at = (minutes: number) => new Date(clock.now().getTime() + minutes * 60_000);
    const job = (id: string) => jobs.jobs.list(at(0)).jobs.find((one) => one.id === id)!;
    const key = (id: string) => `schedule/${opsStatusKey("schedule", jobScheduleKey(id))}`;
    try {
      for (const id of ["j-cccccccc", "j-eeeeeeee"]) expect(jobs.jobs.create(id, spec(id), at(0))).toEqual({ ok: true });
      run("j-cccccccc", at(1), { state: "red", line: "Failed: Command failed with exit code 1", log: ["notes-app answered 503", "Command failed with exit code 1"] });
      // 60 reds after a green: the streak starts at the first red, past the 50 runs a red card reads.
      run("j-eeeeeeee", at(1), { state: "green", line: "up" });
      for (let i = 2; i < 62; i++) run("j-eeeeeeee", at(i), { state: "red", line: "down" });
      expect([job("j-eeeeeeee").redStreak, job("j-eeeeeeee").redSince]).toEqual([60, at(2).toISOString()]);
      expect((await dismiss(key("j-eeeeeeee"), { mark: mark("j-eeeeeeee", "check j-eeeeeeee is up") })).status).toBe(201);
      // Past the 30 days runs are kept: a streak still red keeps its runs, and the newest green as its edge. The sweep also
      // counts today's 7am as missed: one more red.
      jobs.jobs.sweep(at(31 * 24 * 60));
      expect([job("j-eeeeeeee").redSince, job("j-eeeeeeee").redStreak]).toEqual([at(2).toISOString(), 61]);
      // A red run before the newest green is no streak: it goes once it is old, and the green stays.
      run("j-cccccccc", at(3), { state: "green", line: "up" });
      jobs.jobs.sweep(at(62 * 24 * 60));
      expect(job("j-cccccccc").runs.map((one) => one.result)).toEqual(["missed", "missed", "green"]);
    } finally {
      jobs.close();
    }
  });

  it("answers 507 for a new record in a full status store", async () => {
    const full = vi.spyOn(server.app.store, "countOpsStatuses").mockReturnValue(500);
    expect((await send("PUT", "/api/ops/status/app/notes-app", { state: "backlog" }, bearer(BOARD_TOKEN))).status).toBe(507);
    full.mockRestore();
  });

  it("needs Sam's session and same origin to write; the bridge token reads nothing", async () => {
    expect((await dismiss("app/notes-app", undefined, bearer(BOARD_TOKEN))).status).toBe(403);
    expect((await dismiss("app/notes-app", undefined, { ...browser(cookie), cookie: "" })).status).toBe(401);
    expect((await dismiss("app/notes-app", undefined, { ...browser(cookie), origin: "https://evil.example" })).status).toBe(403);
    expect((await send("GET", "/api/ops/dismissals", undefined, bearer(BRIDGE_TOKEN))).status).toBe(401);
    expect((await send("GET", "/api/ops/dismissals", undefined, {})).status).toBe(401);
    expect(await list()).toEqual([]);
  });

  it("refuses a bad kind, key or mark with 400", async () => {
    expect((await dismiss("nope/x")).status).toBe(400);
    expect((await dismiss("app/Bad Key")).status).toBe(400);
    expect((await dismiss("app/notes-app", { mark: "" })).status).toBe(400);
    expect((await dismiss("app/notes-app", { mark: "x", extra: 1 })).status).toBe(400);
    expect((await dismiss("app/notes-app", { mark: "x".repeat(2001) })).status).toBe(400);
  });

  it("forgets a dismissal 14 days on, so a break that never changes comes back", async () => {
    expect((await dismiss("app/notes-app")).status).toBe(201);
    clock.advance(OPS_DISMISS_DAYS * 86_400_000 - 1);
    expect(await list()).toHaveLength(1);
    clock.advance(2);
    expect(await list()).toEqual([]);
  });

  it("answers 507 once it holds 500, and still changes one it holds", async () => {
    for (let i = 0; i < MAX_OPS_DISMISSALS; i += 1) expect((await dismiss(`pr/${i + 1}`)).status).toBe(201);
    expect((await dismiss("pr/9999")).status).toBe(507);
    expect((await dismiss("pr/1", { mark: "changed" })).status).toBe(200);
  });
});

describe("dismissMark", () => {
  it("cuts a mark at its limit", () => {
    const long = dismissMark({ since: null, title: '"'.repeat(300), what: ["11 checks failed", `${"\\".repeat(119)}x, `.repeat(10) + "1 not named"] });
    expect(long).toHaveLength(MAX_OPS_DISMISS_MARK);
  });
});
