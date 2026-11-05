import {
  MAX_OPS_STATUSES,
  OPS_STATUS_FIXED_DAYS,
  OPS_STATUS_KEY_PATTERN,
  OPS_STATUS_KINDS,
  opsStatusPutSchema,
  type OpsStatus,
  type OpsStatusKind,
  type OpsStatusPut,
  type OpsStatusResponse,
} from "../../shared/ops-status.js";
import { DUE_SLACK_MS, MAX_ASK_WHY, MAX_DUE_HISTORY } from "../../shared/asks.js";
import { dueLabel, MAX_MONITOR_DUE_MS, parseDue } from "../../shared/ops-due.js";
import { MAX_OPS_DISMISSALS, OPS_DISMISS_DAYS, opsDismissPutSchema, type OpsDismissalsResponse } from "../../shared/ops-dismiss.js";
import { hasBearer, HttpError, json, readJson, requireBearer, requireSameOrigin } from "../httputil.js";
import { parseRedacted, redactId } from "../redact.js";
import type { Router } from "./router.js";
import { APP_NAME } from "../../shared/names.js";
import { parkPickupAsk, reopenPickupAsk } from "../asks/made.js";

// Ops statuses: what is being done about each failed item. Rivet writes them with the board token, your phone
// reads them with its session. Fixed records go a week after their last change; the app only shows records whose
// item is failing right now. Rivet sets a PR's record fixed when the PR merges or closes, and a ci or schedule record
// when its next run passes (ops/auto-clear.ts); any other record for something that recovered sits unseen until it is
// cleared or pruned.

const BODY_MAX = 16 * 1024;
const PREFIX = "/api/ops/status/";
const DISMISS_PREFIX = "/api/ops/dismissals/";

export function register(router: Router): void {
  const { config, store, requireSession, now } = router.deps;
  const prune = () => store.pruneFixedOpsStatuses(new Date(now().getTime() - OPS_STATUS_FIXED_DAYS * 86_400_000).toISOString());

  router.on("GET", "/api/ops/status", ({ request, response }) => {
    if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
    prune();
    const body: OpsStatusResponse = { statuses: store.listOpsStatuses() };
    json(response, 200, body);
  });

  router.onPrefix("PUT", PREFIX, async ({ request, response, url }) => {
    requireBearer(request, config.boardTokenDigest);
    const { kind, key } = itemOf(url.pathname);
    const ifMatch = parseIfMatch(request.headers["if-match"]);
    const parsed = parseRedacted(opsStatusPutSchema, await readJson(request, BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid status", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    // From here to the write there is no await, so two changes to one item cannot interleave.
    prune();
    const written = writeOpsStatus(store, kind, key, parsed.data, ifMatch, now().toISOString(), { monitor: config.monitorChat });
    // A moved time can raise or end a moved-twice card (asks/waits.ts).
    if (written.status) router.deps.refreshWaits();
    json(response, written.code, written.body, written.status ? etag(written.status.version) : undefined);
  });

  router.onPrefix("DELETE", PREFIX, ({ request, response, url }) => {
    requireBearer(request, config.boardTokenDigest);
    const { kind, key } = itemOf(url.pathname);
    const ifMatch = parseIfMatch(request.headers["if-match"]);
    const current = store.getOpsStatus(kind, key);
    if (!current) throw new HttpError(404, "no status for that item");
    if ((ifMatch !== null && ifMatch !== current.version) || !store.deleteOpsStatus(kind, key, current.version)) {
      json(response, 409, { error: "status version is stale", version: store.getOpsStatus(kind, key)?.version ?? 0 });
      return;
    }
    // A cleared record ends its moved-twice card (asks/waits.ts).
    router.deps.refreshWaits();
    json(response, 200, { ok: true });
  });

  // Your Dismiss on a red item (src/shared/ops-dismiss.ts): your phone writes it with its session, Rivet may read it.
  const pruneDismissals = () => store.pruneOpsDismissals(new Date(now().getTime() - OPS_DISMISS_DAYS * 86_400_000).toISOString());

  router.on("GET", "/api/ops/dismissals", ({ request, response }) => {
    if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
    pruneDismissals();
    const body: OpsDismissalsResponse = { dismissals: store.listOpsDismissals() };
    json(response, 200, body);
  });

  router.onPrefix("PUT", DISMISS_PREFIX, async ({ request, response, url }) => {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    const { kind, key } = itemOf(url.pathname, DISMISS_PREFIX);
    const parsed = opsDismissPutSchema.safeParse(await readJson(request, BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid dismissal", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    pruneDismissals();
    const fresh = !store.listOpsDismissals().some((one) => one.kind === kind && one.key === key);
    if (fresh && store.countOpsDismissals() >= MAX_OPS_DISMISSALS) throw new HttpError(507, `${APP_NAME} holds at most ${MAX_OPS_DISMISSALS} dismissals`);
    const dismissal = { kind, key, mark: parsed.data.mark, at: now().toISOString() };
    store.putOpsDismissal(dismissal);
    if (!store.getOpsStatus(kind, key)) parkPickupAsk(store, { kind, key }, now());
    json(response, fresh ? 201 : 200, dismissal);
  });

  router.onPrefix("DELETE", DISMISS_PREFIX, ({ request, response, url }) => {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    const { kind, key } = itemOf(url.pathname, DISMISS_PREFIX);
    if (!store.deleteOpsDismissal(kind, key)) throw new HttpError(404, "no dismissal for that item");
    reopenPickupAsk(store, { kind, key }, now());
    json(response, 200, { ok: true });
  });
}

/**
 * The one status write, for Rivet's PUT, the phone's Fix it and the auto pick-up: creates the record or changes it,
 * refusing a stale `ifMatch` (null takes any version), and work under way with no done-by time or no reason (400). A
 * done-by over 24 hours out is only `monitor`'s. `askedForTimeAt` is Rivet's own (the auto pick-up's and the late
 * sweeper's), never a PUT's but a rollback's `restore`, which puts back the times the record had.
 * Synchronous, so two changes to one item cannot interleave.
 */
export function writeOpsStatus(
  store: Router["deps"]["store"],
  kind: OpsStatusKind,
  key: string,
  change: OpsStatusPut,
  ifMatch: number | null,
  at: string,
  { monitor, askedForTimeAt }: { monitor?: string; askedForTimeAt?: string } = {},
): { code: 200 | 201 | 400 | 409; body: unknown; status: OpsStatus | null } {
  let dueAt: string | undefined;
  if (change.restore?.dueAt) {
    if (Date.parse(change.restore.dueAt) - Date.parse(at) > MAX_MONITOR_DUE_MS) return { code: 400, body: { error: "a restored done-by is at most 7 days out" }, status: null };
    dueAt = new Date(change.restore.dueAt).toISOString();
  }
  if (change.state === "investigating" || change.state === "in-progress") {
    if ((!change.eta && !dueAt) || !change.why) return { code: 400, body: { error: `${change.state} needs an eta (when it will be done, local time) and a why` }, status: null };
    if (!dueAt) {
      const due = parseDue(change.eta!, new Date(at), monitor !== undefined && change.by === monitor);
      if ("error" in due) return { code: 400, body: { error: due.error }, status: null };
      dueAt = due.dueAt;
    }
  }
  const late = askedForTimeAt ?? (change.restore?.askedForTimeAt ? new Date(change.restore.askedForTimeAt).toISOString() : undefined);
  const current = store.getOpsStatus(kind, key);
  const stale = (version: number) => ({ code: 409 as const, body: { error: "status version is stale", version }, status: null });
  if (ifMatch !== null && ifMatch !== (current?.version ?? 0)) return stale(current?.version ?? 0);
  // A rollback's restore puts back a fixed record as it was, which a fix settled by Rivet may have left with no cause.
  if (change.state === "fixed" && !change.restore && (current?.askedForTimeAt || late) && !hasCause(current, change)) {
    return { code: 400, body: { error: "this item ran late: setting it fixed needs --cause (what held it up) and --prevent (what stops it happening again)" }, status: null };
  }
  if (dueAt) change = { ...change, eta: dueLabel(dueAt, new Date(at)) };
  if (!current) {
    if (store.countOpsStatuses() >= MAX_OPS_STATUSES) throw new HttpError(507, `${APP_NAME} holds at most ${MAX_OPS_STATUSES} statuses`);
    const created = applied({ kind, key, state: change.state, since: at, updatedAt: at, version: 0 }, change, at, store.nextOpsStatusVersion(), dueAt, late);
    if (!store.addOpsStatus(created)) throw new HttpError(409, "status version is stale");
    return { code: 201, body: created, status: created };
  }
  const next = applied(current, change, at, store.nextOpsStatusVersion(), dueAt, late);
  if (!store.replaceOpsStatus(next, current.version)) return stale(store.getOpsStatus(kind, key)?.version ?? 0);
  return { code: 200, body: next, status: next };
}

/** Whether the record has both its cause and its prevent line once the change is laid over it. */
function hasCause(current: OpsStatus | null, change: OpsStatusPut): boolean {
  const has = (field: "cause" | "prevent") => (change[field] === undefined ? current?.[field] !== undefined : change[field] !== null);
  return has("cause") && has("prevent");
}

/**
 * `status` with the change laid over it, at `version`. A failure that comes back after a fix starts again: its `since`
 * moves to now unless the writer gives one. `dueAt` is the write's own done-by: a write with none drops the old one, as
 * `askedForTimeAt` is set only by Rivet and kept: a record that has it ran late.
 */
export function applied(status: OpsStatus, change: OpsStatusPut, at: string, version: number, dueAt?: string, askedForTimeAt?: string): OpsStatus {
  const next: Record<string, unknown> = { ...status, state: change.state };
  if (status.state === "fixed" && change.state !== "fixed") {
    next.since = at;
    for (const field of ["askedForTimeAt", "cause", "prevent", "dueAt", "why", "dueHistory"]) delete next[field];
  }
  // The repo is the named chat's: another chat named without one leaves no other chat's repo behind.
  if (change.chat !== undefined && change.chat !== status.chat && change.repo === undefined) delete next.repo;
  for (const field of ["note", "eta", "why", "cause", "prevent", "chat", "repo", "pr", "issue"] as const) {
    if (change[field] === null) delete next[field];
    else if (change[field] !== undefined) next[field] = change[field];
  }
  // A done-by over 10 minutes later than the one promised is a move, kept as an ask keeps its own. A restore (rivet fix
  // putting a record back) takes back the move the write it undoes made, and gives back the moves of a fixed record that
  // write cleared; it never takes away moves the record still holds. A restored done-by is the old promise, not a move.
  const was = next.dueAt as string | undefined;
  const last = status.dueHistory?.at(-1);
  if (change.restore?.dueHistory?.length && !next.dueHistory) {
    next.dueHistory = change.restore.dueHistory;
  } else if (change.restore && last && dueAt && last.was === dueAt && last.dueAt === was) {
    if (status.dueHistory!.length > 1) next.dueHistory = status.dueHistory!.slice(0, -1);
    else delete next.dueHistory;
  } else if (!change.restore?.dueAt && dueAt && was && Date.parse(dueAt) > Date.parse(was) + DUE_SLACK_MS) {
    const why = (next.why as string | undefined)?.slice(0, MAX_ASK_WHY);
    next.dueHistory = [...(status.dueHistory ?? []), { at, dueAt, was, ...(why ? { why } : {}) }].slice(-MAX_DUE_HISTORY);
  }
  if (dueAt) next.dueAt = dueAt;
  else if (status.dueAt) {
    delete next.dueAt;
    // Its eta was the label of that done-by.
    if (change.eta === undefined) delete next.eta;
  }
  if (askedForTimeAt) next.askedForTimeAt = askedForTimeAt;
  if (change.since) next.since = new Date(change.since).toISOString();
  if (change.by) next.by = change.by;
  else delete next.by;
  // A rollback puts a parked record back with its own time, never later than now: it must not re-park newer trouble.
  const kept = change.state === "parked" ? change.restore?.updatedAt : undefined;
  next.updatedAt = kept && Date.parse(kept) < Date.parse(at) ? new Date(kept).toISOString() : at;
  next.version = version;
  return next as OpsStatus;
}

/** `<kind>/<key>` after the prefix; the key may hold a slash, raw or as %2F. */
function itemOf(pathname: string, prefix = PREFIX): { kind: OpsStatusKind; key: string } {
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const kind = slash === -1 ? rest : rest.slice(0, slash);
  if (!(OPS_STATUS_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind is one of ${OPS_STATUS_KINDS.join(", ")}`);
  let key: string;
  try {
    key = decodeURIComponent(rest.slice(slash + 1));
  } catch {
    throw new HttpError(400, "bad key");
  }
  if (slash === -1 || !OPS_STATUS_KEY_PATTERN.test(key)) throw new HttpError(400, "a key matches [a-z0-9][a-z0-9._/-]{0,99}");
  // A key is stored and shown: one shaped as a credential is refused.
  if (redactId(key) !== key) throw new HttpError(400, "bad key");
  return { kind: kind as OpsStatusKind, key };
}

function parseIfMatch(header: string | undefined): number | null {
  if (header === undefined) return null;
  const value = header.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  if (!/^\d{1,15}$/.test(value)) throw new HttpError(400, "If-Match must be a status version number");
  return Number(value);
}

function etag(version: number): Record<string, string> {
  return { etag: `"${version}"` };
}
