import { HttpError, json, readJson, requireBearer } from "../httputil.js";
import { FLY_FIELDS, GITHUB_FIELDS, parseRedacted } from "../redact.js";
import * as costs from "./costs.js";
import {
  ackSchema,
  backlogSnapshotSchema,
  briefingNoteSchema,
  claudeUsageSnapshotSchema,
  flySnapshotSchema,
  githubSnapshotSchema,
  macSnapshotSchema,
  OPS_MAX_BYTES,
} from "../ops/schema.js";
import { createOps } from "../ops/service.js";
import { NEWS_MS } from "../../shared/short-titles.js";
import type { Router } from "./router.js";

// Ops: the PR / CI / deploy board, app status, Mac health, Claude usage, the timeline, search history and briefings.
// Everything here reads; nothing it does changes GitHub, Fly or the Mac.

const SMALL_BODY_MAX = 16 * 1024;

export function register(router: Router): void {
  const { config, store, bridge, requireSession, push, now, addUpdate, refreshWaits, workers, titles } = router.deps;
  const ops = createOps({
    dataDir: config.dataDir,
    store,
    bridge,
    push,
    checks: config.healthChecks,
    fetch: globalThis.fetch,
    now,
    addUpdate,
    workers: () => workers().workers,
    refreshWaits,
    pickup: { send: (pickup) => bridge.sendOpsPickup(pickup), monitorChat: config.monitorChat },
  });
  router.onClose(() => ops.close());
  costs.register(router);
  // Tests and local development never probe the health URLs or send briefings.
  if (config.production) ops.start();

  router.on("GET", "/api/ops", ({ request, response }) => {
    requireSession(request);
    json(response, 200, ops.view());
  });

  router.on("GET", "/api/ops/timeline", ({ request, response }) => {
    requireSession(request);
    // A merge or ship from the last 12 hours, the floor's news, wears a short title for Rivet's bubble.
    const at = now();
    const read = ops.timeline();
    const days = read.days.map((day) => ({
      ...day,
      events: day.events.map((event) =>
        (event.kind === "merged" || event.kind === "shipped") && event.at !== null && at.getTime() - Date.parse(event.at) <= NEWS_MS
          ? { ...event, short: titles.of(event.title.replace(/\s*\(#\d+\)\s*$/, ""), undefined, at) }
          : event,
      ),
    }));
    json(response, 200, { ...read, days });
  });

  router.on("GET", "/api/ops/search", ({ request, response, url }) => {
    requireSession(request);
    const query = (url.searchParams.get("q") ?? "").slice(0, 100);
    json(response, 200, { results: ops.searchHistory(query) });
  });

  router.on("GET", "/api/briefing", ({ request, response, url }) => {
    requireSession(request);
    const id = url.searchParams.get("id");
    json(response, 200, { briefing: id === null ? ops.latestBriefing() : ops.store.getBriefing(id) });
  });

  router.on("PUT", "/api/bridge/ops/github", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(githubSnapshotSchema, await readJson(request, OPS_MAX_BYTES), undefined, GITHUB_FIELDS);
    if (!parsed.success) {
      json(response, 400, { error: "invalid github snapshot", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    bridge.seen();
    await ops.putGithub(parsed.data);
    json(response, 200, { ok: true });
  });

  router.on("PUT", "/api/bridge/ops/backlog", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(backlogSnapshotSchema, await readJson(request, OPS_MAX_BYTES));
    if (!parsed.success) {
      json(response, 400, { error: "invalid backlog snapshot", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    bridge.seen();
    ops.putBacklog(parsed.data);
    json(response, 200, { ok: true });
  });

  router.on("POST", "/api/bridge/late-ask-ack", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = ackSchema.safeParse(await readJson(request, 4096));
    if (!parsed.success) throw new HttpError(400, "invalid ack");
    bridge.seen();
    if (!ops.ackLateAsk(parsed.data.id, parsed.data.delivered)) throw new HttpError(404, "no such late question");
    json(response, 200, { ok: true });
  });

  router.on("POST", "/api/bridge/ops-pickup-ack", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = ackSchema.safeParse(await readJson(request, 4096));
    if (!parsed.success) throw new HttpError(400, "invalid ack");
    bridge.seen();
    if (!ops.ackPickup(parsed.data.id, parsed.data.delivered)) throw new HttpError(404, "no such pick-up");
    json(response, 200, { ok: true });
  });

  // The Machines trend: the Mac's readings over the last week, or only those after `since` (epoch seconds).
  router.on("GET", "/api/machines/history", ({ request, response, url }) => {
    requireSession(request);
    const since = Number(url.searchParams.get("since"));
    json(response, 200, ops.machineHistory(Number.isSafeInteger(since) && since > 0 ? since : 0));
  });

  router.on("PUT", "/api/bridge/ops/mac", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(macSnapshotSchema, await readJson(request, OPS_MAX_BYTES));
    if (!parsed.success) {
      json(response, 400, { error: "invalid mac snapshot", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    bridge.seen();
    ops.putMac(parsed.data);
    json(response, 200, { ok: true });
  });

  router.on("PUT", "/api/bridge/ops/claude", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(claudeUsageSnapshotSchema, await readJson(request, OPS_MAX_BYTES));
    if (!parsed.success) {
      json(response, 400, { error: "invalid claude usage", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    bridge.seen();
    ops.putClaude(parsed.data);
    json(response, 200, { ok: true });
  });

  router.on("PUT", "/api/bridge/ops/fly", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(flySnapshotSchema, await readJson(request, OPS_MAX_BYTES), undefined, FLY_FIELDS);
    if (!parsed.success) {
      json(response, 400, { error: "invalid fly snapshot", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    bridge.seen();
    await ops.putFly({ ...parsed.data, source: parsed.data.source ?? null });
    json(response, 200, { ok: true });
  });

  router.on("POST", "/api/bridge/briefing-note", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(briefingNoteSchema, await readJson(request, SMALL_BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid note");
    const briefing = ops.addNote(parsed.data.text);
    if (!briefing) throw new HttpError(404, "no briefing yet");
    json(response, 200, { briefing: briefing.id, notes: briefing.notes.length });
  });
}
