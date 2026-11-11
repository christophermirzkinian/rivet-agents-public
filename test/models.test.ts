import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditEntry } from "../src/shared/command.js";
import { defaultPicks, effortOnModel, effortsFor, jobOf, MODEL_JOBS, modelPicksSchema, type ModelSettingsResponse } from "../src/shared/models.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, putBoard, startServer, type TestServer } from "./helpers.js";

let server: TestServer;
let cookie: string;
let seq = 0;
const clientId = () => `models-${Date.now()}-${(seq += 1)}`;

beforeEach(async () => {
  server = await startServer();
  cookie = server.cookie();
  await putBoard(server.base);
});

afterEach(async () => {
  await server.close();
});

const post = (body: Record<string, unknown>, headers: Record<string, string> = browser(cookie)) =>
  fetch(`${server.base}/api/actions/models`, { method: "POST", headers, body: JSON.stringify(body) });
/** A report from one bridge run, unless the body names its own. */
const report = (body: Record<string, unknown>, headers: Record<string, string> = bearer(BRIDGE_TOKEN)) =>
  fetch(`${server.base}/api/bridge/models`, { method: "PUT", headers, body: JSON.stringify({ run: "run-1", ...body }) });
const settings = async () => (await (await fetch(`${server.base}/api/settings/models`, { headers: { cookie } })).json()) as ModelSettingsResponse;

async function connectBridge(): Promise<{ events(): number; payloads(): Record<string, unknown>[]; waitFor(n: number): Promise<void>; abort(): void }> {
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
  const blocks = () => buffer.split("\n\n").filter((block) => block.startsWith("event: models"));
  const events = () => blocks().length;
  const payloads = () => blocks().map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as Record<string, unknown>);
  const waitFor = async (count: number) => {
    for (let i = 0; i < 200 && events() < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events()).toBeGreaterThanOrEqual(count);
  };
  return { events, payloads, waitFor, abort: () => controller.abort() };
}

const pick = (key: string, model: string, effort: string) => ({ ...defaultPicks(), [key]: { model, effort } });

describe("the model picks schema", () => {
  it("defaults to what each job runs on today", () => {
    const opusHigh = { model: "claude-opus-5-5", effort: "high" };
    expect(defaultPicks()).toEqual({
      monitor: opusHigh,
      "work-chats": opusHigh,
      "app-look": opusHigh,
      "review-lens": opusHigh,
      "hard-problem": { model: "claude-fable-5-2", effort: "high" },
      "small-jobs": { model: "claude-haiku-5-5", effort: "medium" },
      "daily-jobs": opusHigh,
      "night-jobs": { model: "gpt-6.1-sol", effort: "high" },
    });
    expect(jobOf("daily-jobs")!.models).toEqual(["claude-opus-5-5", "claude-fable-5-2"]);
  });

  it("takes the defaults, and every allowed model on a job", () => {
    expect(modelPicksSchema.safeParse(defaultPicks()).success).toBe(true);
    for (const job of MODEL_JOBS) for (const model of job.models) for (const effort of effortsFor(model, job)) expect(modelPicksSchema.safeParse(pick(job.key, model, effort)).success).toBe(true);
  });

  it("GPT on reviews takes only Extra high, Opus and Fable there High to Max, and GPT on night jobs Low to Extra high", () => {
    const reviews = jobOf("review-lens")!;
    expect(effortsFor("gpt-6.1-sol", reviews)).toEqual(["xhigh"]);
    for (const effort of ["low", "medium", "high", "max"]) expect(modelPicksSchema.safeParse(pick("review-lens", "gpt-6.1-sol", effort)).success).toBe(false);
    expect(modelPicksSchema.safeParse(pick("review-lens", "gpt-6.1-sol", "xhigh")).success).toBe(true);
    for (const model of ["claude-opus-5-5", "claude-fable-5-2"]) {
      expect(effortsFor(model, reviews)).toEqual(["high", "xhigh", "max"]);
      for (const effort of ["low", "medium"]) expect(modelPicksSchema.safeParse(pick("review-lens", model, effort)).success).toBe(false);
      expect(modelPicksSchema.safeParse(pick("review-lens", model, "high")).success).toBe(true);
    }
    expect(effortsFor("claude-opus-5-5", jobOf("monitor")!)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortsFor("gpt-6.1-sol", jobOf("night-jobs")!)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(defaultPicks()["review-lens"]).toEqual({ model: "claude-opus-5-5", effort: "high" });
  });

  it("the effort follows the model: kept if the new model takes it, else the job's, else the new model's highest", () => {
    const reviews = jobOf("review-lens")!;
    expect(effortOnModel(reviews, "gpt-6.1-sol", "high")).toBe("xhigh");
    expect(effortOnModel(reviews, "claude-opus-5-5", "xhigh")).toBe("xhigh");
    expect(effortOnModel(jobOf("night-jobs")!, "gpt-6.1-sol", "low")).toBe("low");
    expect(effortOnModel(jobOf("monitor")!, "claude-fable-5-2", "max")).toBe("max");
  });

  it("refuses Sonnet, a bare alias, Haiku on reviews, GPT on the monitor and Max on GPT", () => {
    expect(modelPicksSchema.safeParse(pick("work-chats", "claude-sonnet-5", "high")).success).toBe(false);
    expect(modelPicksSchema.safeParse(pick("work-chats", "opus", "high")).success).toBe(false);
    expect(modelPicksSchema.safeParse(pick("review-lens", "claude-haiku-5-5", "high")).success).toBe(false);
    expect(modelPicksSchema.safeParse(pick("monitor", "gpt-6.1-sol", "high")).success).toBe(false);
    expect(modelPicksSchema.safeParse(pick("night-jobs", "gpt-6.1-sol", "max")).success).toBe(false);
    expect(modelPicksSchema.safeParse(pick("monitor", "claude-opus-5-5", "turbo")).success).toBe(false);
  });

  it("refuses a missing job, an extra job and an extra field on a pick", () => {
    const { monitor: _, ...missing } = defaultPicks();
    expect(modelPicksSchema.safeParse(missing).success).toBe(false);
    expect(modelPicksSchema.safeParse({ ...defaultPicks(), extra: { model: "claude-opus-5-5", effort: "high" } }).success).toBe(false);
    expect(modelPicksSchema.safeParse({ ...defaultPicks(), monitor: { model: "claude-opus-5-5", effort: "high", note: "x" } }).success).toBe(false);
  });
});

describe("saving the picks", () => {
  it("needs a session and the app's origin, only allowed picks, and the save they were picked over", async () => {
    const body = { clientId: clientId(), jobs: defaultPicks(), base: null };
    const { cookie: _, ...noCookie } = browser(cookie);
    expect((await post(body, noCookie)).status).toBe(401);
    expect((await post(body, { ...browser(cookie), origin: "https://evil.example" })).status).toBe(403);
    expect((await post(body, bearer(BOARD_TOKEN))).status).toBe(403);
    expect((await post({ jobs: defaultPicks() })).status).toBe(400);
    expect((await post({ ...body, jobs: pick("monitor", "gpt-6.1-sol", "high") })).status).toBe(400);
    expect((await post({ ...body, jobs: pick("review-lens", "claude-opus-5-5", "low") })).status).toBe(400);
    expect((await post({ ...body, jobs: pick("review-lens", "claude-fable-5-2", "medium") })).status).toBe(400);
    expect((await post({ ...body, extra: true })).status).toBe(400);
    const { base: _base, ...noBase } = body;
    expect((await post(noBase)).status).toBe(400);
    expect((await post({ ...body, base: 7 })).status).toBe(400);
    expect((await post({ ...body, base: "x".repeat(101) })).status).toBe(400);
  });

  it("sends the picks and their base to the bridge, and a retry under the same clientId is the same row", async () => {
    const stream = await connectBridge();
    const id = clientId();
    const jobs = pick("monitor", "claude-fable-5-2", "high");
    const first = await post({ clientId: id, jobs, base: "a1" });
    expect(first.status).toBe(202);
    const entry = (await first.json()) as AuditEntry;
    expect(entry).toMatchObject({ kind: "models", status: "queued", models: jobs, base: "a1" });
    await stream.waitFor(1);
    expect(stream.payloads()[0]).toMatchObject({ id: entry.id, models: jobs, base: "a1" });
    const again = (await (await post({ clientId: id, jobs, base: "a1" })).json()) as AuditEntry;
    expect(again.id).toBe(entry.id);
    expect((await post({ clientId: id, jobs: defaultPicks(), base: "a1" })).status).toBe(409);
    expect((await post({ clientId: id, jobs, base: null })).status).toBe(409);
    stream.abort();
  });
});

describe("the bridge's report", () => {
  it("needs the bridge's bearer and a well-formed body", async () => {
    const body = { file: null, status: {} };
    expect((await report(body, bearer(BOARD_TOKEN))).status).toBe(401);
    expect((await report(body, { "content-type": "application/json" })).status).toBe(401);
    expect((await report({ file: null, status: { monitor: { model: "claude-opus-5-5", effort: "high" } } })).status).toBe(400);
    expect((await report({ file: null, status: {}, extra: 1 })).status).toBe(400);
    expect((await report({ run: undefined, file: null, status: {} })).status).toBe(400);
    expect((await report({ run: "r".repeat(101), file: null, status: {} })).status).toBe(400);
    expect((await report({ run: "r".repeat(100), file: null, status: {} })).status).toBe(200);
  });

  it("GET is empty until the Mac reports, then fills any job the file lacks with its default", async () => {
    const before = await settings();
    expect(before).toMatchObject({ current: null, updated: null, status: {}, reportedAt: null });
    expect(before.jobs.map((job) => job.key)).toEqual(MODEL_JOBS.map((job) => job.key));
    const updated = { at: "2026-11-11T08:14:00.000Z", by: "The owner (Rivet)", action: "a1" };
    const status = { "hard-problem": { model: "claude-opus-5-5", effort: "high", reason: "Fable is at 86% this week", at: "2026-11-11T08:00:00.000Z" } };
    const sent = { file: { jobs: { monitor: { model: "claude-fable-5-2", effort: "xhigh" }, "review-lens": { model: "claude-haiku-5-5", effort: "high" } }, updated }, status };
    expect((await report(sent)).status).toBe(200);
    const after = await settings();
    expect(after.current?.monitor).toEqual({ model: "claude-fable-5-2", effort: "xhigh" });
    expect(after.current?.["review-lens"]).toEqual({ model: "claude-opus-5-5", effort: "high", fromDefault: true });
    expect(after.current?.["night-jobs"]).toEqual({ model: "gpt-6.1-sol", effort: "high", fromDefault: true });
    expect(after.updated).toEqual(updated);
    expect(after.status).toEqual(status);
    expect(after.reportedAt).toEqual(expect.any(String));
  });

  it("a token in a fallback's reason is redacted before GET serves it", async () => {
    const token = `ghp_${"Zq9".repeat(12)}`;
    const reason = `Fable refused: ${token}`;
    const at = "2026-11-11T08:00:00.000Z";
    expect((await report({ file: null, status: { "hard-problem": { model: "claude-opus-5-5", effort: "high", reason, at } } })).status).toBe(200);
    const served = (await settings()).status["hard-problem"]!;
    expect(served.reason).not.toContain(token);
    expect(served.reason).toMatch(/^Fable refused: /);
  });

  it("a report of the same run read before the kept one is answered stale and dropped; one without readAt is taken as now", async () => {
    const file = (action: string) => ({ jobs: { monitor: { model: "claude-fable-5-2", effort: "high" } }, updated: { at: "2026-11-11T08:14:00.000Z", by: "The owner (Rivet)", action } });
    const answer = async (body: Record<string, unknown>) => {
      const response = await report(body);
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await answer({ readAt: 2000, file: file("b"), status: {} })).toEqual({ ok: true });
    expect(await answer({ readAt: 1000, file: file("a"), status: {} })).toEqual({ ok: true, stale: true });
    expect((await settings()).updated?.action).toBe("b");
    expect(await answer({ readAt: 3000, file: file("c"), status: {} })).toEqual({ ok: true });
    expect((await settings()).updated?.action).toBe("c");
    expect(await answer({ file: file("old-bridge"), status: {} })).toEqual({ ok: true });
    expect((await settings()).updated?.action).toBe("old-bridge");
    expect(await answer({ readAt: 1000, file: file("after"), status: {} })).toEqual({ ok: true });
    expect((await settings()).updated?.action).toBe("after");
    expect((await report({ readAt: 1.5, file: null, status: {} })).status).toBe(400);
  });

  it("a report from another bridge run lands whatever its readAt, as the Mac's clock may have stepped back across the restart", async () => {
    const file = (action: string) => ({ jobs: { monitor: { model: "claude-fable-5-2", effort: "high" } }, updated: { at: "2026-11-11T08:14:00.000Z", by: "The owner (Rivet)", action } });
    const answer = async (body: Record<string, unknown>) => (await report(body)).json();
    expect(await answer({ run: "before", readAt: 5000, file: file("a"), status: {} })).toEqual({ ok: true });
    expect(await answer({ run: "before", readAt: 4000, file: file("stale"), status: {} })).toEqual({ ok: true, stale: true });
    expect(await answer({ run: "after", readAt: 1000, file: file("b"), status: {} })).toEqual({ ok: true });
    expect((await settings()).updated?.action).toBe("b");
    expect(await answer({ run: "after", readAt: 900, file: file("stale"), status: {} })).toEqual({ ok: true, stale: true });
    expect((await settings()).updated?.action).toBe("b");
    // Arrival can't order two runs: a late report from the ended run lands, and the live run's next report replaces it.
    // No run is ever shut out.
    expect(await answer({ run: "before", readAt: 5001, file: file("late"), status: {} })).toEqual({ ok: true });
    expect((await settings()).updated?.action).toBe("late");
    // The live run's next report lands even with a readAt below its own earlier one, as the kept report is the other run's.
    expect(await answer({ run: "after", readAt: 950, file: file("b"), status: {} })).toEqual({ ok: true });
    expect((await settings()).updated?.action).toBe("b");
  });

  it("GET says when the Mac could not read its picks file", async () => {
    expect((await settings()).fileError).toBeNull();
    expect((await report({ file: null, fileError: "model-routing.json unreadable: EACCES", status: {} })).status).toBe(200);
    const after = await settings();
    expect(after).toMatchObject({ current: null, updated: null, fileError: "model-routing.json unreadable: EACCES" });
    expect(after.reportedAt).toEqual(expect.any(String));
  });

  it("GET needs a session", async () => {
    expect((await fetch(`${server.base}/api/settings/models`)).status).toBe(401);
  });
});
