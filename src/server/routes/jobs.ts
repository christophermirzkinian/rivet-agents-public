import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { AuditEntry } from "../../shared/command.js";
import {
  confirmLine,
  isUpCheck,
  jobChangeSchema,
  jobCreateSchema,
  jobCron,
  JOB_ID_PATTERN,
  JOB_LOG_LINES,
  MAX_ACTIVE_JOBS,
  jobRemoveSchema,
  nextRunTime,
  runReportSchema,
  dayTimeWords,
  taskReportSchema,
  whenWords,
  type JobAction,
  type JobSpec,
} from "../../shared/jobs.js";
import type { ActionRequest, CommandStore } from "../commandstore.js";
import { hasBearer, HttpError, json, readJson, requireBearer, requireSameOrigin } from "../httputil.js";
import { JOB_NOTE_PREFIX, type JobOutcome } from "../jobs.js";
import { pushFailing } from "./schedules.js";
import { redactBody, redactLog } from "../redact.js";
import type { Router } from "./router.js";

// Your own jobs. Rivet sets one with the board token once you say Yes on its confirm card; the phone pauses, runs or
// deletes a red one with its session. The Mac schedules each job (bridge/lib/jobs.mjs), and the job's runs report here
// with the bridge token. The server is the one writer of a job's state: a paused or deleted job's runs are refused here,
// whatever the Mac still does.

const JOB_BODY_MAX = 8 * 1024;
const RUN_BODY_MAX = 32 * 1024;
const PREFIX = "/api/jobs/";
const BRIDGE_PREFIX = "/api/bridge/jobs/";
const SWEEP_MS = 60_000;
/** A job the Mac could not make says so: its Resume makes it again. */
const NOT_SET = "Not set on the Mac";

type Sent = { status: number; entry: AuditEntry; error?: string; undelivered?: boolean };

export interface JobRouteDeps {
  dispatch(kind: "job", clientId: string, request: ActionRequest, at: string): Sent;
  sentBody(sent: Sent): unknown;
  /** The apps an up check may name; the names in RIVET_HEALTH_URLS by default. */
  upApps?: ReadonlySet<string>;
}

/** A job id: "j-" and 8 characters the server picks. */
function newJobId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `j-${Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

/** What the Mac makes a job's automation from. */
const actionSpec = (job: JobSpec) => ({ name: job.name, words: job.words, kind: job.kind, ...(job.check ? { check: job.check } : {}), cron: jobCron(job.when) });

/** `/api/jobs/<id>` or `/api/bridge/jobs/<id>/<tail>`: the job id, or a 404. */
function jobIdOf(pathname: string, prefix: string, tail?: string): string {
  const rest = pathname.slice(prefix.length);
  const [id, more, ...extra] = rest.split("/");
  if (!id || !JOB_ID_PATTERN.test(id) || extra.length || (tail === undefined ? more !== undefined : more !== tail)) throw new HttpError(404, "not found");
  return id;
}

export function registerJobs(router: Router, commands: CommandStore, deps: JobRouteDeps): { acked(entry: AuditEntry): void } {
  const { config, bridge, requireSession, push, logger, now, addUpdate, schedules } = router.deps;
  const jobs = schedules.jobs;
  const upApps = deps.upApps ?? new Set(config.healthChecks.map((check) => check.name));

  /** Rivet's board token, or your session from the app itself. */
  function requireWriter(request: IncomingMessage): void {
    if (hasBearer(request, config.boardTokenDigest)) return;
    requireSameOrigin(request, config.origin);
    requireSession(request);
  }

  function publish(outcome: JobOutcome | undefined): void {
    if (!outcome) return;
    pushFailing(push, logger, outcome.fresh);
    for (const note of outcome.notes) {
      const added = addUpdate({ id: note.id, title: note.title, ask: note.ask });
      if (added.status !== 200 && added.status !== 409) logger.error(`[jobs] update ${note.id} not added: ${added.error ?? added.status}`);
    }
  }

  function sweep(): void {
    publish(jobs.sweep(now()));
  }
  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref();
  router.onClose(() => clearInterval(timer));

  /** An earlier try under this clientId: the same request gets its answer again, anything else a 409. */
  function replay(clientId: string, same: (job: JobAction | undefined) => boolean): AuditEntry | null {
    const existing = commands.getActionByClientId(clientId);
    if (!existing) return null;
    if (existing.kind !== "job" || !same(existing.job)) throw new HttpError(409, "clientId was already used for a different action");
    return existing;
  }

  function parse<T>(schema: { safeParse(body: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }, body: unknown, what: string): T {
    // Checked as sent, then redacted and checked again, as parseRedacted does.
    const sent = schema.safeParse(body);
    const parsed = sent.success ? schema.safeParse(redactBody(sent.data)) : sent;
    if (!parsed.success) throw new HttpError(400, `invalid ${what}: ${parsed.error.issues[0]?.message ?? "bad input"}`);
    return parsed.data;
  }

  router.on("GET", "/api/jobs", ({ request, response }) => {
    if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
    sweep();
    json(response, 200, jobs.list(now()));
  });

  router.on("POST", "/api/jobs", async ({ request, response }) => {
    requireWriter(request);
    const body = parse(jobCreateSchema, await readJson(request, JOB_BODY_MAX), "job");
    if (body.job.check && isUpCheck(body.job.check) && !upApps.has(body.job.check.app))
      throw new HttpError(400, `invalid job: ${body.job.check.app} is not a registered app with a public health check`);
    const at = now();
    const line = confirmLine(body.job);
    if (body.dryRun) {
      if (jobs.activeCount() >= MAX_ACTIVE_JOBS) throw new HttpError(409, `${MAX_ACTIVE_JOBS} jobs are on already: pause or delete one first`);
      json(response, 200, { line, whenText: whenWords(body.job.when), nextRun: nextRunTime(body.job.when, at)?.toISOString() ?? null });
      return;
    }
    const spec = actionSpec(body.job);
    const existing = replay(body.clientId, (job) => job?.op === "create" && JSON.stringify(job.spec) === JSON.stringify(spec));
    if (existing) {
      const job = jobs.get(existing.job!.id);
      json(response, 200, { entry: existing, line, ...(job ? { job: jobs.view(job, at) } : {}) });
      return;
    }
    const id = newJobId();
    const made = jobs.create(id, body.job, at);
    if (!made.ok) throw new HttpError(409, made.reason);
    const sent = deps.dispatch("job", body.clientId, { job: { op: "create", id, spec } }, at.toISOString());
    if (sent.status !== 202) {
      jobs.remove(id);
      json(response, sent.status, deps.sentBody(sent));
      return;
    }
    jobs.sentAction(id, sent.entry.id);
    json(response, 202, { entry: sent.entry, line, job: jobs.view(jobs.get(id)!, at) });
  });

  router.onPrefix("PATCH", PREFIX, async ({ request, response, url }) => {
    requireWriter(request);
    const id = jobIdOf(url.pathname, PREFIX);
    const body = parse(jobChangeSchema, await readJson(request, JOB_BODY_MAX), "job change");
    const existing = replay(body.clientId, (job) => job?.id === id && (job.op === body.op || (body.op === "resume" && job.op === "create")));
    if (existing) {
      json(response, 200, existing);
      return;
    }
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, "no such job");
    const remake = body.op === "resume" && job.state === "paused" && !!job.note?.startsWith(NOT_SET);
    const at = now();
    if (job.state === "removing") throw new HttpError(409, "it is being deleted");
    if (body.op === "run" && job.state === "paused") throw new HttpError(409, "it is paused: resume it first");
    if (body.op === "run" && jobs.isRunning(id)) throw new HttpError(409, "it is running now");
    const before = job.state;
    if (body.op !== "run") {
      const changed = jobs.setState(id, body.op === "pause" ? "paused" : "active", at);
      if (!changed.ok) throw new HttpError(409, changed.reason);
    }
    const sent = deps.dispatch("job", body.clientId, { job: remake ? { op: "create", id, spec: actionSpec(job.spec) } : { op: body.op, id } }, at.toISOString());
    // A pause holds here whatever the Mac does; a resume the Mac never got is undone.
    if (sent.status !== 202 && body.op === "resume") jobs.setState(id, before, at, job.note);
    // A run changes no state, so it never stands in for the newest change whose failure undoes it.
    if (sent.status === 202 && body.op !== "run") jobs.sentAction(id, sent.entry.id);
    json(response, sent.status, deps.sentBody(sent));
  });

  router.onPrefix("DELETE", PREFIX, async ({ request, response, url }) => {
    requireWriter(request);
    const id = jobIdOf(url.pathname, PREFIX);
    const body = parse(jobRemoveSchema, await readJson(request, JOB_BODY_MAX), "job removal");
    const existing = replay(body.clientId, (job) => job?.op === "remove" && job.id === id);
    if (existing) {
      json(response, 200, existing);
      return;
    }
    if (!jobs.get(id)) throw new HttpError(404, "no such job");
    const sent = deps.dispatch("job", body.clientId, { job: { op: "remove", id } }, now().toISOString());
    // It goes when the Mac says its automation went too: an automation left behind would run on, out of sight.
    if (sent.status === 202) {
      jobs.markRemoving(id);
      jobs.sentAction(id, sent.entry.id);
    }
    json(response, sent.status, deps.sentBody(sent));
  });

  router.onPrefix("PUT", BRIDGE_PREFIX, async ({ request, response, url }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const report = url.pathname.endsWith("/report");
    const id = jobIdOf(url.pathname, BRIDGE_PREFIX, report ? "report" : "runs");
    const raw = await readJson(request, RUN_BODY_MAX);
    bridge.seen();
    sweep();
    if (report) {
      const body = parse(taskReportSchema, raw, "job report");
      const done = jobs.report(id, body.run, body.state, body.line, body.url, now());
      if (done.status !== 200) throw new HttpError(done.status, done.error ?? "refused");
      publish(done.outcome);
      json(response, 200, { ok: true });
      return;
    }
    // The log is read as one run before each line alone, so a value under its name goes.
    const sent = runReportSchema.safeParse(raw);
    const body = parse(runReportSchema, sent.success && sent.data.log ? { ...sent.data, log: redactLog(sent.data.log, JOB_LOG_LINES) } : raw, "run report");
    if (body.state === "start" || body.state === "look") {
      const started = body.state === "start" ? jobs.start(id, body, now()) : jobs.look(id, body, now());
      if (!started) throw new HttpError(404, "no such job");
      json(response, 200, started);
      return;
    }
    const done = jobs.finish(id, body, now());
    if (done.status !== 200) throw new HttpError(done.status, done.error ?? "refused");
    publish(done.outcome);
    json(response, 200, { ok: true });
  });

  return {
    /**
     * The Mac's answer to a job action: a job it could not make stays paused, saying why, a resume it could not do is
     * undone, a Run now it could not start lets go of its run, and a job goes once its automation is removed, or is
     * back as it was, saying why, when it could not be.
     */
    acked(entry: AuditEntry): void {
      const action = entry.job;
      if (entry.kind !== "job" || !action) return;
      const failed = entry.status === "failed" || entry.status === "refused";
      const job = jobs.get(action.id);
      if (!job) return;
      // A late answer to an older action (a retried ack) never undoes a newer one; a make that failed under a pause
      // still marks it not set, so its Resume makes it again.
      const newest = job.lastAction === entry.id;
      const why = (fallback: string) => (entry.detail?.reason ?? fallback).replace(/\.$/, "");
      if (action.op === "create" && failed && (newest || job.state === "paused")) jobs.notSet(action.id, `${NOT_SET}: ${why("the Mac could not make its automation")}. Resume to try again, or Delete.`);
      else if (action.op === "remove" && entry.status === "succeeded") jobs.remove(action.id);
      else if (action.op === "remove" && failed && newest) jobs.unremove(action.id, `Delete did not go through: ${(entry.detail?.reason ?? "the Mac could not remove its automation").replace(/\.$/, "")}. Try again.`);
      else if (action.op === "resume" && failed && newest) jobs.setState(action.id, "paused", now(), `Resume did not go through: ${why("the Mac could not switch it on")}.`);
      else if (action.op === "run" && failed) jobs.runNotStarted(action.id, entry.id, (entry.detail?.reason ?? "the Mac could not run it").replace(/\.$/, ""), now());
      else if (action.op === "create" && entry.status === "succeeded") {
        const next = nextRunTime(job.spec.when, now());
        publish({
          fresh: [],
          notes: [{ id: `${JOB_NOTE_PREFIX}${job.id}-set`, title: `Job set: ${job.spec.name}`, ask: `${whenWords(job.spec.when)}.${next ? ` Next run ${dayTimeWords(next)}.` : ""}` }],
        });
      }
    },
  };
}
