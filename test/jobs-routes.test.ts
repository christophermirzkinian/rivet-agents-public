import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BoardResponse, Reply } from "../src/shared/board.js";
import type { AuditEntry } from "../src/shared/command.js";
import type { JobsResponse } from "../src/shared/jobs.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, fakeClock, putBoard, startServer, type TestServer } from "./helpers.js";

// 7:00am Saturday 24 Oct 2026 local time.
const SAT_7AM = Date.parse("2026-10-23T20:00:00.000Z");
const HOUR = 3_600_000;

let server: TestServer;
let cookie: string;
let clock: ReturnType<typeof fakeClock>;
let seq = 0;
const clientId = () => `jobs-${Date.now()}-${(seq += 1)}`;

const SPEC = {
  name: "Notes app up",
  words: "check notes app is up",
  kind: "check",
  check: { probe: "up", app: "notes-app", where: "mac", onRed: "card" },
  when: { every: "day", at: "07:00" },
  cards: "red",
};

beforeEach(async () => {
  clock = fakeClock(SAT_7AM - 30 * 60_000);
  server = await startServer({ RIVET_HEALTH_URLS: "notes-app=https://notes.example.com/healthz" }, { now: clock.now });
  cookie = server.cookie();
  await putBoard(server.base);
});
afterEach(async () => {
  await server.close();
});

const send = (method: string, path: string, body: unknown, headers: Record<string, string> = bearer(BOARD_TOKEN)) =>
  fetch(`${server.base}${path}`, { method, headers, body: JSON.stringify(body) });
const create = (body: Record<string, unknown> = {}, headers?: Record<string, string>) => send("POST", "/api/jobs", { clientId: clientId(), job: SPEC, ...body }, headers);
const list = async () => (await (await fetch(`${server.base}/api/jobs`, { headers: { cookie } })).json()) as JobsResponse;
const report = (id: string, body: Record<string, unknown>, headers = bearer(BRIDGE_TOKEN)) => send("PUT", `/api/bridge/jobs/${id}/runs`, body, headers);
const board = async () => ((await (await fetch(`${server.base}/api/board`, { headers: { cookie } })).json()) as BoardResponse).board!;

async function connectBridge(): Promise<{ events(): { event: string; data: Record<string, unknown> }[]; waitFor(n: number): Promise<void>; abort(): void }> {
  const controller = new AbortController();
  const response = await fetch(`${server.base}/api/bridge/events`, { headers: bearer(BRIDGE_TOKEN), signal: controller.signal });
  expect(response.status).toBe(200);
  let buffer = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch {}
  })();
  const events = () =>
    buffer
      .split("\n\n")
      .filter((block) => block.startsWith("event:"))
      .map((block) => {
        const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        return { event: fields.event!, data: JSON.parse(fields.data!) as Record<string, unknown> };
      })
      .filter((event) => event.event === "job");
  const waitFor = async (count: number) => {
    for (let i = 0; i < 200 && events().length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events().length).toBeGreaterThanOrEqual(count);
  };
  return { events, waitFor, abort: () => controller.abort() };
}

const ack = (id: string, status: string, detail?: Record<string, unknown>) =>
  send("POST", "/api/bridge/action-ack", { id, status, ...(detail ? { detail } : {}) }, bearer(BRIDGE_TOKEN));

/** A job made with the Mac connected and its make acknowledged. */
async function madeJob(spec: Record<string, unknown> = SPEC): Promise<string> {
  const mac = await connectBridge();
  const made = await send("POST", "/api/jobs", { clientId: clientId(), job: spec });
  expect(made.status).toBe(202);
  const body = (await made.json()) as { entry: AuditEntry; job: { id: string } };
  await mac.waitFor(1);
  expect((await ack(body.entry.id, "succeeded")).status).toBe(200);
  // Left connected: the server's close ends the stream, where a dropped one holds the close for seconds.
  return body.job.id;
}

describe("job writes", () => {
  it("take the board token or a same-origin session, nothing else", async () => {
    expect((await create({}, { "content-type": "application/json" })).status).toBe(403);
    expect((await create({}, bearer(BRIDGE_TOKEN))).status).toBe(403);
    expect((await create({}, { ...browser(cookie), cookie: "" })).status).toBe(401);
    expect((await create({}, { cookie, "content-type": "application/json" })).status).toBe(403);
    expect((await create({ dryRun: true }, browser(cookie))).status).toBe(200);
    expect((await create({ dryRun: true })).status).toBe(200);
    expect((await fetch(`${server.base}/api/jobs`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/jobs`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(401);
    expect((await fetch(`${server.base}/api/jobs`, { headers: bearer(BOARD_TOKEN) })).status).toBe(200);
  });

  it("refuses a denied word or script with the reason, and anything extra", async () => {
    const merge = await create({ job: { ...SPEC, words: "merge the ready PRs" } });
    expect(merge.status).toBe(400);
    expect(((await merge.json()) as { error: string }).error).toContain('never does "merge"');
    expect((await create({ job: { ...SPEC, check: { script: "test:deploy", where: "mac", onRed: "card" } } })).status).toBe(400);
    expect((await create({ job: { ...SPEC, check: { script: "deploy:site", where: "mac", onRed: "card" } } })).status).toBe(400);
    expect((await create({ job: { ...SPEC, check: { script: "test", where: "remote", onRed: "card" } } })).status).toBe(400);
    const unknown = await create({ job: { ...SPEC, check: { probe: "up", app: "no-such-app" } } });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("invalid job: no-such-app is not a registered app with a public health check");
    expect((await create({ job: { ...SPEC, check: { probe: "up", app: "notes-app", url: "https://example.com" } } })).status).toBe(400);
    expect((await create({ job: { ...SPEC, command: "rm -rf ~" } })).status).toBe(400);
    expect((await create({ shell: true })).status).toBe(400);
  });

  it("gives the confirm card's line on a dry run and stores nothing", async () => {
    const dry = await create({ dryRun: true });
    expect(await dry.json()).toMatchObject({ line: "New job · Daily 7:00am · Check notes app is up · Card only if red", whenText: "Daily 7:00am", nextRun: "2026-10-23T20:00:00.000Z" });
    expect((await list()).jobs).toEqual([]);
  });

  it("makes nothing while the Mac is off line", async () => {
    const made = await create();
    expect(made.status).toBe(503);
    expect((await list()).jobs).toEqual([]);
  });

  it("sends the Mac the job, says it is set once made, and keeps one the Mac could not make, paused", async () => {
    const mac = await connectBridge();
    const made = await create();
    expect(made.status).toBe(202);
    const body = (await made.json()) as { entry: AuditEntry; job: { id: string } };
    await mac.waitFor(1);
    expect(mac.events()[0]!.data.job).toEqual({
      op: "create",
      id: body.job.id,
      spec: { name: "Notes app up", words: "check notes app is up", kind: "check", check: SPEC.check, cron: "0 7 * * *" },
    });
    await ack(body.entry.id, "succeeded");
    const set = (await board()).needs.find((need) => need.id === `jobnote-${body.job.id}-set`);
    expect(set).toMatchObject({ kind: "decision", title: "Job set: Notes app up", ask: "Daily 7:00am. Next run Sat 24 Oct 7:00am.", options: [{ label: "Got it" }], push: "fyi" });

    const other = await create({ job: { ...SPEC, name: "Second" } });
    const second = (await other.json()) as { entry: AuditEntry; job: { id: string } };
    await mac.waitFor(2);
    await ack(second.entry.id, "failed", { reason: "no such script" });
    expect((await list()).jobs.map((job) => [job.name, job.state]).sort()).toEqual([["Notes app up", "active"], ["Second", "paused"]]);
    mac.abort();
  });

  it("keeps a job whose make the Mac could not confirm, paused and saying why, so Resume makes it again and Delete removes it", async () => {
    const mac = await connectBridge();
    const made = (await (await create()).json()) as { entry: AuditEntry; job: { id: string } };
    await mac.waitFor(1);
    await ack(made.entry.id, "failed", { reason: "the Mac restarted while doing this" });
    const kept = await list();
    expect(kept.jobs[0]).toMatchObject({ id: made.job.id, state: "paused", note: "Not set on the Mac: the Mac restarted while doing this. Resume to try again, or Delete.", nextRun: null });
    expect(kept.limits.active).toBe(0);
    expect(await (await report(made.job.id, { run: "run-00000001", state: "start" })).json()).toEqual({ go: false, note: "paused" });
    expect((await board()).needs.some((need) => need.id === `jobnote-${made.job.id}-set`)).toBe(false);

    const resumed = await send("PATCH", `/api/jobs/${made.job.id}`, { clientId: clientId(), op: "resume" });
    expect(resumed.status).toBe(202);
    await mac.waitFor(2);
    expect(mac.events()[1]!.data.job).toEqual({ op: "create", id: made.job.id, spec: { name: SPEC.name, words: SPEC.words, kind: "check", check: SPEC.check, cron: "0 7 * * *" } });
    expect((await list()).jobs[0]).toMatchObject({ state: "active" });
    await ack(((await resumed.json()) as AuditEntry).id, "failed", { reason: "The Mac could not do it: launchctl refused it." });
    expect((await list()).jobs[0]).toMatchObject({ state: "paused", note: "Not set on the Mac: The Mac could not do it: launchctl refused it. Resume to try again, or Delete." });
    const again = await send("PATCH", `/api/jobs/${made.job.id}`, { clientId: clientId(), op: "resume" });
    await mac.waitFor(3);
    await ack(((await again.json()) as AuditEntry).id, "succeeded");
    expect((await list()).jobs[0]).toMatchObject({ state: "active" });
    expect((await list()).jobs[0]!.note).toBeUndefined();
    expect((await board()).needs.some((need) => need.id === `jobnote-${made.job.id}-set`)).toBe(true);

    const other = (await (await create({ job: { ...SPEC, name: "Other" } })).json()) as { entry: AuditEntry; job: { id: string } };
    await mac.waitFor(4);
    await ack(other.entry.id, "failed", { reason: "the Mac restarted while doing this" });
    const gone = await send("DELETE", `/api/jobs/${other.job.id}`, { clientId: clientId() });
    await mac.waitFor(5);
    expect(mac.events()[4]!.data.job).toEqual({ op: "remove", id: other.job.id });
    await ack(((await gone.json()) as AuditEntry).id, "succeeded");
    expect((await list()).jobs.map((job) => job.id)).toEqual([made.job.id]);
    mac.abort();
  });

  it("keeps a job its Resume made again running when the first make's failure is acknowledged again late", async () => {
    const mac = await connectBridge();
    const made = (await (await create()).json()) as { entry: AuditEntry; job: { id: string } };
    await mac.waitFor(1);
    await ack(made.entry.id, "failed", { reason: "launchctl refused it" });
    const resumed = await send("PATCH", `/api/jobs/${made.job.id}`, { clientId: clientId(), op: "resume" });
    await mac.waitFor(2);
    await ack(((await resumed.json()) as AuditEntry).id, "succeeded");
    expect((await list()).jobs[0]).toMatchObject({ state: "active" });
    await ack(made.entry.id, "failed", { reason: "launchctl refused it" });
    const kept = (await list()).jobs[0]!;
    expect(kept.state).toBe("active");
    expect(kept.note).toBeUndefined();
    mac.abort();
  });

  it("marks a job not set when its make fails after it was paused, so its Resume makes it again", async () => {
    const mac = await connectBridge();
    const made = (await (await create()).json()) as { entry: AuditEntry; job: { id: string } };
    await mac.waitFor(1);
    expect((await send("PATCH", `/api/jobs/${made.job.id}`, { clientId: clientId(), op: "pause" })).status).toBe(202);
    await mac.waitFor(2);
    await ack(made.entry.id, "failed", { reason: "launchctl refused it" });
    expect((await list()).jobs[0]).toMatchObject({ state: "paused", note: "Not set on the Mac: launchctl refused it. Resume to try again, or Delete." });
    await send("PATCH", `/api/jobs/${made.job.id}`, { clientId: clientId(), op: "resume" });
    await mac.waitFor(3);
    expect(mac.events()[2]!.data.job).toMatchObject({ op: "create", id: made.job.id });
    mac.abort();
  });

  it("answers a retry of the same clientId the same, and refuses a different one", async () => {
    const mac = await connectBridge();
    const id = clientId();
    const first = await send("POST", "/api/jobs", { clientId: id, job: SPEC });
    expect(first.status).toBe(202);
    const again = await send("POST", "/api/jobs", { clientId: id, job: SPEC });
    expect(again.status).toBe(200);
    expect((await list()).jobs).toHaveLength(1);
    expect((await send("POST", "/api/jobs", { clientId: id, job: { ...SPEC, name: "Other" } })).status).toBe(409);
    mac.abort();
  });

  it("pauses, runs and deletes a job; a paused job's runs are refused", async () => {
    const id = await madeJob();
    const mac = await connectBridge();
    expect((await send("PATCH", `/api/jobs/${id}`, { clientId: clientId(), op: "pause" }, browser(cookie))).status).toBe(202);
    expect((await list()).jobs[0]!.state).toBe("paused");
    expect(await (await report(id, { run: "run-00000001", state: "start" })).json()).toEqual({ go: false, note: "paused" });
    expect((await send("PATCH", `/api/jobs/${id}`, { clientId: clientId(), op: "run" })).status).toBe(409);
    expect((await send("PATCH", `/api/jobs/${id}`, { clientId: clientId(), op: "resume" })).status).toBe(202);
    expect((await send("PATCH", `/api/jobs/${id}`, { clientId: clientId(), op: "run" })).status).toBe(202);
    await mac.waitFor(3);
    expect(await (await report(id, { run: "run-00000003", state: "start", manual: true })).json()).toMatchObject({ go: true });
    const busy = await send("PATCH", `/api/jobs/${id}`, { clientId: clientId(), op: "run" });
    expect([busy.status, ((await busy.json()) as { error: string }).error]).toEqual([409, "it is running now"]);
    expect((await report(id, { run: "run-00000003", state: "green" })).status).toBe(200);
    expect(mac.events().map((event) => (event.data.job as { op: string }).op)).toEqual(["pause", "resume", "run"]);
    // Delete keeps the job, running nothing, until the Mac says its automation went; a failure puts it back.
    const first = await send("DELETE", `/api/jobs/${id}`, { clientId: clientId() });
    expect(first.status).toBe(202);
    expect((await list()).jobs[0]!.state).toBe("removing");
    expect(await (await report(id, { run: "run-00000002", state: "start" })).json()).toEqual({ go: false, note: "it is being deleted" });
    expect((await send("PATCH", `/api/jobs/${id}`, { clientId: clientId(), op: "pause" })).status).toBe(409);
    await mac.waitFor(4);
    await ack(((await first.json()) as AuditEntry).id, "failed", { reason: "The Mac could not do it: launchctl refused it." });
    expect((await list()).jobs[0]).toMatchObject({ state: "active", note: "Delete did not go through: The Mac could not do it: launchctl refused it. Try again." });
    const again = await send("DELETE", `/api/jobs/${id}`, { clientId: clientId() });
    expect(again.status).toBe(202);
    await mac.waitFor(5);
    await ack(((await again.json()) as AuditEntry).id, "succeeded");
    expect((await list()).jobs).toEqual([]);
    expect((await report(id, { run: "run-00000002", state: "start" })).status).toBe(404);
    expect((await send("PATCH", "/api/jobs/j-../../x", { clientId: clientId(), op: "run" })).status).toBe(404);
    mac.abort();
  });
});

describe("job action answers", () => {
  it("undo a change only for the job's newest action, so a late failed resume never pauses a newer one", async () => {
    const id = await madeJob();
    const mac = await connectBridge();
    const patch = async (op: string) => ((await (await send("PATCH", `/api/jobs/${id}`, { clientId: clientId(), op })).json()) as AuditEntry).id;
    await patch("pause");
    const firstResume = await patch("resume");
    await patch("pause");
    const secondResume = await patch("resume");
    await mac.waitFor(4);
    await ack(secondResume, "succeeded");
    await ack(firstResume, "failed", { reason: "launchctl refused it" });
    expect((await list()).jobs[0]!.state).toBe("active");
    mac.abort();
  });

  it("undo a failed resume even after a Run now sent behind it, as a run changes no state", async () => {
    const id = await madeJob();
    const mac = await connectBridge();
    const patch = async (op: string) => ((await (await send("PATCH", `/api/jobs/${id}`, { clientId: clientId(), op })).json()) as AuditEntry).id;
    await patch("pause");
    const resume = await patch("resume");
    const run = await patch("run");
    await mac.waitFor(3);
    await ack(resume, "failed", { reason: "launchctl refused it" });
    expect((await list()).jobs[0]).toMatchObject({ state: "paused", note: "Resume did not go through: launchctl refused it." });
    await ack(run, "refused", { reason: "skipped: paused" });
    expect((await list()).jobs[0]!.state).toBe("paused");
    mac.abort();
  });
});

describe("a task's Run now the Mac could not start", () => {
  const TASK = { name: "Issues", words: "look over the open issues", kind: "task", when: { every: "week", day: "mon", at: "09:00" }, cards: "red" };
  const runNow = async () => {
    const sent = await send("PATCH", `/api/jobs/${id}`, { clientId: clientId(), op: "run" });
    expect(sent.status).toBe(202);
    return ((await sent.json()) as AuditEntry).id;
  };
  let id = "";

  it("lets go of its run when the Mac says it failed, so Run now can go again at once", async () => {
    id = await madeJob(TASK);
    const mac = await connectBridge();
    const action = await runNow();
    await mac.waitFor(1);
    expect(await (await report(id, { run: "run-00000001", state: "start", manual: true, usage: 10, action })).json()).toMatchObject({ go: true });
    await ack(action, "failed", { reason: "The Mac could not do it: launchctl refused it." });
    expect((await list()).jobs[0]!.runs[0]).toMatchObject({ id: "run-00000001", result: "skipped", line: "skipped: the Mac did not start it: The Mac could not do it: launchctl refused it" });
    await runNow();
    mac.abort();
  });

  it("never lets go of a later Run now's run when an earlier Run now's failure is answered again", async () => {
    id = await madeJob(TASK);
    const mac = await connectBridge();
    const first = await runNow();
    await mac.waitFor(1);
    await ack(first, "refused", { reason: "The server said no." });
    const second = await runNow();
    await mac.waitFor(2);
    expect(await (await report(id, { run: "run-0000000b", state: "start", manual: true, usage: 10, action: second })).json()).toMatchObject({ go: true });
    await ack(second, "succeeded", { reason: "Started on the Mac." });
    await ack(first, "refused", { reason: "The server said no." });
    expect((await list()).jobs[0]!.runs.find((run) => run.id === "run-0000000b")).toMatchObject({ result: "running" });
    expect((await send("PUT", `/api/bridge/jobs/${id}/report`, { run: "run-0000000b", state: "green", line: "3 issues, none new" }, bearer(BRIDGE_TOKEN))).status).toBe(200);
    mac.abort();
  });

  it("keeps a started Run now running until its chat reports, and a scheduled start never joins it", async () => {
    id = await madeJob(TASK);
    const mac = await connectBridge();
    await runNow();
    await mac.waitFor(1);
    expect(await (await report(id, { run: "run-00000002", state: "start", manual: true, usage: 10 })).json()).toMatchObject({ go: true, job: { name: TASK.name, words: TASK.words } });
    expect(await (await report(id, { run: "run-00000003", state: "start", usage: 10 })).json()).toEqual({ go: false, note: "the last run is still going" });
    clock.advance(3 * 60_000);
    expect((await list()).jobs[0]!.runs.find((run) => run.id === "run-00000002")).toMatchObject({ result: "running" });
    mac.abort();
  });
});

describe("run reports", () => {
  it("take the bridge token only", async () => {
    const id = await madeJob();
    expect((await report(id, { run: "run-00000001", state: "start" }, bearer(BOARD_TOKEN))).status).toBe(401);
    expect((await report(id, { run: "run-00000001", state: "start" }, browser(cookie))).status).toBe(401);
    expect((await report(id, { run: "run 1", state: "start" })).status).toBe(400);
    expect((await report(id, { run: "run-00000001", state: "start" })).status).toBe(200);
    expect((await report(id, { run: "run-00000001", state: "red", log: Array(21).fill("x") })).status).toBe(400);
    expect((await report(id, { run: "run-00000001", state: "red", url: "http://example.com" })).status).toBe(400);
  });

  it("put one Needs-you card on the feed for a red streak, then a Got it card back to green", async () => {
    const id = await madeJob();
    clock.advance(30 * 60_000);
    expect(await (await report(id, { run: "run-00000001", state: "start" })).json()).toMatchObject({ go: true, run: "run-00000001", job: { id, kind: "check", check: SPEC.check } });
    // The log is read as one run: a made-up password under its name goes.
    const log = ["sim 3: 97.9%", "sim 7: 95.1%", "password: | # the sim key", "  correct horse qzvtkfakepass"];
    expect((await report(id, { run: "run-00000001", state: "red", line: "2 of 9 sims out of range", log })).status).toBe(200);
    expect(JSON.stringify(await list())).toContain("sim 7: 95.1%");
    expect(JSON.stringify([await list(), await board()])).not.toContain("qzvtkfakepass");
    const reds = (await board()).needs.filter((need) => need.id.startsWith("schedule-job-"));
    expect(reds).toHaveLength(1);
    expect(reds[0]).toMatchObject({ kind: "decision", title: "Notes app up is red" });
    expect(reds[0]!.ask).toContain("2 of 9 sims out of range");

    clock.advance(24 * HOUR);
    await report(id, { run: "run-00000002", state: "start" });
    await report(id, { run: "run-00000002", state: "red", line: "still out" });
    expect((await board()).needs.filter((need) => need.id.startsWith("schedule-job-")).map((need) => need.id)).toEqual([reds[0]!.id]);
    expect((await list()).jobs[0]).toMatchObject({ redStreak: 2, lastRun: { result: "red", line: "still out" } });

    clock.advance(24 * HOUR);
    await report(id, { run: "run-00000003", state: "start" });
    await report(id, { run: "run-00000003", state: "green", line: "all 9 in range" });
    const after = (await board()).needs;
    expect(after.filter((need) => need.id.startsWith("schedule-job-"))).toEqual([]);
    expect(after.find((need) => need.id === `jobnote-${id}-run-00000003`)).toMatchObject({ kind: "decision", title: "Notes app up is back to green", options: [{ label: "Got it" }], push: "fyi" });
  });

  it("closes a task's run from its chat with rivet job report", async () => {
    const id = await madeJob({ name: "Issues", words: "look over the open issues", kind: "task", when: { every: "week", day: "mon", at: "09:00" }, cards: "every" });
    expect(await (await report(id, { run: "run-00000001", state: "start", usage: 40 })).json()).toMatchObject({ go: true });
    expect((await send("PUT", `/api/bridge/jobs/${id}/report`, { run: "run-00000001", state: "green", line: "3 issues, none new" }, bearer(BOARD_TOKEN))).status).toBe(401);
    expect((await send("PUT", `/api/bridge/jobs/${id}/report`, { state: "green", line: "3 issues, none new" }, bearer(BRIDGE_TOKEN))).status).toBe(400);
    expect((await send("PUT", `/api/bridge/jobs/${id}/report`, { run: "run-00000001", state: "green", line: "3 issues, none new" }, bearer(BRIDGE_TOKEN))).status).toBe(200);
    expect((await send("PUT", `/api/bridge/jobs/${id}/report`, { run: "run-00000001", state: "green", line: "again" }, bearer(BRIDGE_TOKEN))).status).toBe(409);
    expect((await board()).needs.find((need) => need.id === `jobnote-${id}-run-00000001`)).toMatchObject({ title: "Issues: green", ask: expect.stringContaining("3 issues, none new") });
  });

  it("cards a missed run when GET /api/jobs sweeps", async () => {
    await madeJob();
    clock.advance(49 * HOUR);
    const jobs = await list();
    expect(jobs.jobs[0]!.runs.map((run) => run.result)).toEqual(["missed"]);
    expect((await board()).needs.filter((need) => need.id.startsWith("schedule-job-"))).toHaveLength(1);
  });

  it("takes your answer on the red card and passes Rivet the fix detail", async () => {
    const id = await madeJob();
    clock.advance(30 * 60_000);
    await report(id, { run: "run-00000001", state: "start" });
    await report(id, { run: "run-00000001", state: "red", line: "it broke" });
    const card = (await board()).needs.find((need) => need.id.startsWith("schedule-job-"))!;
    const answered = await send("POST", "/api/replies", { clientId: clientId(), itemId: card.id, decision: "choice", choice: "Fix it", rev: card.rev }, browser(cookie));
    expect(answered.status).toBe(201);
    const { replies } = (await (await fetch(`${server.base}/api/replies?handled=false`, { headers: bearer(BOARD_TOKEN) })).json()) as { replies: Reply[] };
    expect(replies.find((reply) => reply.itemId === card.id)).toMatchObject({ choice: "Fix it", item: { ask: expect.stringContaining(`rivet fix schedule job-${id}`) } });
    expect((await board()).needs.filter((need) => need.id.startsWith("schedule-job-"))).toEqual([]);
  });
});
