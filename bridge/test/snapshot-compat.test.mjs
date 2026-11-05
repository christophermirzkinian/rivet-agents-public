import test from "node:test";
import { z } from "zod";
import assert from "node:assert/strict";
import { putSnapshot, snapshotWithoutRejectedKeys } from "../lib/snapshot-compat.mjs";

const issue = (path, keys) => ({ code: "unrecognized_keys", path, keys });

test("nested GitHub fields are removed from every row beyond the 20-issue limit without mutating caches", () => {
  const snapshot = { prs: Array.from({ length: 30 }, (_, number) => ({ number, branch: "feature", oneTap: { state: "wait", newer: true }, checks: { failedJobs: [], state: "pass" } })) };
  const original = structuredClone(snapshot);
  const result = snapshotWithoutRejectedKeys(snapshot, [issue(["prs", 0], ["branch"]), issue(["prs", 0, "oneTap"], ["newer"]), issue(["prs", 0, "checks"], ["failedJobs"])]);
  assert.deepEqual(result.prs, snapshot.prs.map(({ number }) => ({ number, oneTap: { state: "wait" }, checks: { state: "pass" } })));
  assert.deepEqual(snapshot, original);
  assert.deepEqual(snapshotWithoutRejectedKeys(snapshot, [issue(["prs", 0], ["oneTap"])]).prs[29], { number: 29, branch: "feature", checks: { failedJobs: [], state: "pass" } });
});

test("nested array paths generalize each array index", () => {
  const snapshot = { apps: [{ releases: [{ sha: "a", id: 1 }] }, { releases: [{ sha: "b", id: 2 }, { sha: "c", id: 3 }] }] };
  assert.deepEqual(snapshotWithoutRejectedKeys(snapshot, [issue(["apps", 0, "releases", 0], ["sha"])]), { apps: [{ releases: [{ id: 1 }] }, { releases: [{ id: 2 }, { id: 3 }] }] });
});

test("invalid paths, prototype keys and non-key errors leave the payload alone", () => {
  const snapshot = { workers: [{ busy: true }] };
  for (const issues of [[], [issue(["workers", -1], ["busy"])], [issue(["workers", 99], ["busy"])], [issue(["workers", "0"], ["busy"])], [issue(["__proto__"], ["busy"])], [issue(["workers", 0], ["constructor"])], [issue(["workers", 0], ["absent"])], [{ code: "invalid_type", path: ["workers"] }], [issue(["workers", 0], ["busy"]), { code: "invalid_type", path: [] }]]) {
    assert.equal(snapshotWithoutRejectedKeys(snapshot, issues), null);
  }
  assert.equal(snapshot.workers[0].busy, true);
});

test("snapshot transport stops when rejected keys make no further progress and never retries auth", async () => {
  for (const status of [400, 401, 403, 500]) {
    const sent = [];
    const put = async (body) => { sent.push(body); return Response.json({ issues: [issue(["workers", 0], ["busy", "branch"])] }, { status }); };
    const snapshot = { workers: Array.from({ length: 30 }, () => ({ chat: "chat", busy: true, branch: "feature" })) };
    const response = await putSnapshot(put, snapshot);
    assert.equal(response.status, status);
    assert.equal(sent.length, status === 400 ? 2 : 1);
    if (status === 400) assert.deepEqual(sent[1].workers, snapshot.workers.map(() => ({ chat: "chat" })));
    assert.equal(snapshot.workers[29].busy, true);
  }
});

test("an old server's rejected root push queue is stripped and the workers still go", async () => {
  const sent = [];
  const put = async (body) => {
    sent.push(body);
    return "pushQueue" in body ? Response.json({ issues: [issue([], ["pushQueue"])] }, { status: 400 }) : Response.json({ ok: true });
  };
  const snapshot = { workers: [{ chat: "chat" }], pushQueue: [{ chat: "chat", repo: "r", position: 1, at: 5 }] };
  const response = await putSnapshot(put, snapshot);
  assert.equal(response.status, 200);
  assert.deepEqual(sent.at(-1), { workers: [{ chat: "chat" }] });
  assert.equal(snapshot.pushQueue.length, 1);
});

test("detailed invalid payloads do not use the legacy fallback", async () => {
  for (const issues of [[], [{ code: "invalid_type", path: [] }], null]) {
    let sends = 0;
    await putSnapshot(async () => { sends++; return Response.json({ issues }, { status: 400 }); }, {}, () => { throw new Error("unexpected fallback"); });
    assert.equal(sends, 1);
  }
});


test("capped strict receiver reveals later run and merged fields after 30 rejected PR rows", async () => {
  const schema = z.object({
    prs: z.array(z.object({ number: z.number() }).strict()),
    runs: z.array(z.object({ id: z.number() }).strict()),
    merged: z.array(z.object({ number: z.number() }).strict()),
  }).strict();
  const snapshot = {
    prs: Array.from({ length: 30 }, (_, number) => ({ number, branch: "feature", oneTap: {} })),
    runs: Array.from({ length: 30 }, (_, id) => ({ id, failedJobs: [] })),
    merged: [{ number: 5, mergeSha: "abc" }],
  };
  const original = structuredClone(snapshot);
  const sent = [];
  const response = await putSnapshot(async (body) => {
    sent.push(body);
    const parsed = schema.safeParse(body);
    return parsed.success ? Response.json({ ok: true }) : Response.json({ issues: parsed.error.issues.slice(0, 20) }, { status: 400 });
  }, snapshot);
  assert.equal(response.status, 200);
  assert.equal(sent.length, 4);
  assert.equal(schema.safeParse(sent.at(-1)).success, true);
  assert.deepEqual(snapshot, original);
});

test("compatibility progress is capped at four retries", async () => {
  let sends = 0;
  const snapshot = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
  const response = await putSnapshot(async (body) => {
    sends++;
    return Response.json({ issues: [issue([], [Object.keys(body)[0]])] }, { status: 400 });
  }, snapshot);
  assert.equal(response.status, 400);
  assert.equal(sends, 5);
});

test("legacy fallback runs at most once and auth stops after compatibility progress", async () => {
  let legacyCalls = 0;
  let sends = 0;
  await putSnapshot(async () => { sends++; return Response.json({}, { status: 400 }); }, { a: 1 }, () => { legacyCalls++; return {}; });
  assert.equal(sends, 2);
  assert.equal(legacyCalls, 1);
  sends = 0;
  const response = await putSnapshot(async () => {
    sends++;
    return Response.json({ issues: [issue([], ["a"])] }, { status: sends === 1 ? 400 : 401 });
  }, { a: 1 });
  assert.equal(response.status, 401);
  assert.equal(sends, 2);
});

test("an old server that rejects a worker's workRepo gets the workers without it", async () => {
  const schema = z.object({ workers: z.array(z.object({ chat: z.string() }).strict()) }).strict();
  const snapshot = { workers: [{ chat: "gamma", workRepo: "example-org/other-repo" }, { chat: "plain" }] };
  const sent = [];
  const response = await putSnapshot(async (body) => {
    sent.push(body);
    const parsed = schema.safeParse(body);
    return parsed.success ? Response.json({ ok: true }) : Response.json({ issues: parsed.error.issues.slice(0, 20) }, { status: 400 });
  }, snapshot);
  assert.equal(response.status, 200);
  assert.deepEqual(sent.at(-1), { workers: [{ chat: "gamma" }, { chat: "plain" }] });
  assert.equal(snapshot.workers[0].workRepo, "example-org/other-repo");
});
