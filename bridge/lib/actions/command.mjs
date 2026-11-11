import { createHash } from "node:crypto";
import path from "node:path";

import { appChatLine, MAX_APP_CHAT_TEXT, MAX_CONVERSATION_TITLE, MAX_OWNER_TEXT, MAX_QUOTE_TEXT, PAUSE_LINE, sendToChatLine } from "../command-templates.mjs";
import { ActionJournal } from "../journal.mjs";
import { redactDeep, shapeText } from "../redact-cut.mjs";
import { resolveChatTerminal } from "../terminals.mjs";
import { fetchImage } from "../images.mjs";
import { runJobAction, validJobAction } from "../jobs.mjs";
import { wakeSchedules } from "../schedules/index.mjs";
import { SCHEDULE_ID_RE, toggleSchedule } from "../schedules/toggle.mjs";
import { currentBase, savedReason, sendModelReport, validPicks, writePicks } from "../model-routing.mjs";
import { isChatName, isId, isImageId, MAX_CHAT_IMAGES, validFiles } from "../validate.mjs";
import { isRepo, repoAllowlist } from "../../../src/shared/repos.ts";
import { runMerge } from "./merge.mjs";

// Chat from the app, and the worker sheet's send and pause, all typed into a chat of the chat runner. Every external
// call is a fixed argument array through deps.exec (execFile, no shell); owner text only ever reaches a chat inside the
// quoted field of a command-templates.mjs line, on the runner's stdin.

/** @typedef {import("./index.mjs").ActionContext} ActionContext */
/** @typedef {import("./index.mjs").ActionResult} ActionResult */

export const COMMAND_TIMEOUTS = Object.freeze({
  interrupt: 15_000,
  http: 15_000,
  gh: 60_000,
});
/**
 * What the app hears of a typed chat line: a line reported lost is not delivered, one with no proof is only typed.
 * @param {{ confirmed?: boolean, lost?: boolean }} delivery
 */
const chatAckStatus = (delivery) => (delivery.lost ? "failed" : delivery.confirmed ? "typed" : "unconfirmed");
export const ACK_RETRY_BASE_MS = 2_000;
export const ACK_RETRY_MAX_MS = 60_000;
export const ACK_RETRY_TRIES = 60;
/** actionDetailSchema's text limits (src/shared/command.ts), in UTF-16 units: a reason takes 300, a line 200. */
export const MAX_ACK_REASON = 300;
export const MAX_ACK_LINE = 200;
const MAX_OUTSTANDING = 200;
const MAX_ISSUE_TEXT = 2000;
/** The label a backlog issue's Start work puts on it. */
export const WORKING_LABEL = "agent:working";

/** @param {unknown} list @param {number} max */
const fitAll = (list, max) => (Array.isArray(list) ? list.map((item) => (typeof item === "string" ? shapeText(item, max) : item)) : list);

/**
 * An ack's text redacted whole and only then cut to the server's limits, at the one place every ack (a replayed one
 * too) goes through, so its senders pass text uncut. Every string in it, nested ones and fields with no cap here
 * included, is redacted first.
 * @param {Record<string, unknown>} detail
 */
export function fitAckDetail(detail) {
  const out = { ...redactDeep(detail) };
  if (typeof out.reason === "string") out.reason = shapeText(out.reason, MAX_ACK_REASON);
  if (Array.isArray(out.lines)) out.lines = fitAll(out.lines, MAX_ACK_LINE);
  return out;
}

// A report journalled before its text was redacted whole, unmarked, may hold a token's cut-off head that no
// redaction can recognise: sent again, its text goes as a fixed note, its status and the rest as they were.
const LEGACY_DETAIL = "details not kept (written before redaction)";

/** @param {Record<string, unknown> | undefined} detail */
function legacyDetail(detail) {
  if (!detail) return detail;
  const out = { ...detail };
  if (typeof out.reason === "string") out.reason = LEGACY_DETAIL;
  if (Array.isArray(out.lines)) out.lines = [LEGACY_DETAIL];
  return out;
}

export { MAX_CHAT_IMAGES };

/** Server action kinds the bridge answers for after a reconnect; chat is replayed instead. */
const OUTSTANDING_KINDS = new Set(["send", "pause", "merge", "schedule", "job", "models"]);
/** Reports after which the bridge does nothing more for an action. */
const DONE = new Set(["typed", "unconfirmed", "failed", "refused", "merged", "succeeded"]);

/** @param {unknown} v */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const isText = (v, max = 2 * MAX_OWNER_TEXT) => typeof v === "string" && v.trim() !== "" && v.length <= max;
/** @param {unknown} v */
const isPr = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/**
 * @param {string} event
 * @param {unknown} raw
 * @returns {{ ok: true, value: { id: string, pr?: number, headSha?: string, schedule?: string, on?: boolean, job?: import("../jobs.mjs").JobAction, issue?: number, op?: "comment" | "close" | "label", text?: string, image?: string, images?: string[], files?: import("../validate.mjs").FileRef[], replyTo?: string, quote?: import("../command-templates.mjs").Quote, conversation?: import("../command-templates.mjs").Conversation, repo?: string, chat?: string, models?: unknown, base?: unknown } }
 *   | { ok: false, id: string, reason: string }}
 */
export function validateCommand(event, raw) {
  if (!isRecord(raw)) return { ok: false, id: "?", reason: "not-an-object" };
  const r = /** @type {Record<string, unknown>} */ (raw);
  const id = isId(r.id) ? /** @type {string} */ (r.id) : "?";
  /** @param {string} reason */
  const bad = (reason) => ({ ok: /** @type {const} */ (false), id, reason });
  if (id === "?") return bad("bad-id");
  if (event === "merge") {
    if (!isRepo(r.repo)) return bad("bad-repo");
    if (!isPr(r.pr)) return bad("bad-pr");
    if (typeof r.headSha !== "string" || !/^[0-9a-f]{40}$/.test(r.headSha)) return bad("bad-head");
    return { ok: true, value: { id, repo: r.repo, pr: /** @type {number} */ (r.pr), headSha: r.headSha } };
  }
  /** @type {{ id: string, schedule?: string, on?: boolean, job?: import("../jobs.mjs").JobAction, issue?: number, op?: "comment" | "close" | "label", text?: string, image?: string, images?: string[], files?: import("../validate.mjs").FileRef[], replyTo?: string, quote?: import("../command-templates.mjs").Quote, conversation?: import("../command-templates.mjs").Conversation, repo?: string, chat?: string, models?: unknown, base?: unknown }} */
  const value = { id };
  if (event === "chat" && r.image !== undefined) {
    if (!isImageId(r.image)) return bad("bad-image");
    value.image = /** @type {string} */ (r.image);
  }
  if (event === "chat" && r.images !== undefined) {
    const images = r.images;
    const valid =
      r.image === undefined &&
      Array.isArray(images) &&
      images.length >= 2 &&
      images.length <= MAX_CHAT_IMAGES &&
      images.every(isImageId) &&
      new Set(images).size === images.length;
    if (!valid) return bad("bad-images");
    value.images = /** @type {string[]} */ ([...images]);
  }
  if (event === "chat" && r.files !== undefined) {
    const files = validFiles(r.files);
    if (!files) return bad("bad-files");
    value.files = files;
  }
  if (event === "chat" && r.replyTo !== undefined) {
    if (!isId(r.replyTo)) return bad("bad-reply-to");
    value.replyTo = /** @type {string} */ (r.replyTo);
  }
  if (event === "chat" && r.quote !== undefined) {
    const q = r.quote;
    const valid =
      value.replyTo !== undefined &&
      isRecord(q) &&
      Object.keys(q).length === 2 &&
      (q.from === "owner" || q.from === "rivet") &&
      typeof q.text === "string" &&
      q.text.length <= 4 * MAX_QUOTE_TEXT;
    if (!valid) return bad("bad-quote");
    value.quote = { from: /** @type {"owner" | "rivet"} */ (q.from), text: /** @type {string} */ (q.text) };
  }
  if (event === "chat" && r.conversation !== undefined) {
    const c = r.conversation;
    const valid = isRecord(c) && Object.keys(c).length === 2 && isId(c.id) && typeof c.title === "string" && c.title.length <= 4 * MAX_CONVERSATION_TITLE;
    if (!valid) return bad("bad-conversation");
    value.conversation = { id: /** @type {string} */ (c.id), title: /** @type {string} */ (c.title) };
  }
  if (
    event === "send" ||
    (event === "chat" && (r.text !== undefined || (value.image === undefined && value.images === undefined && value.files === undefined)))
  ) {
    if (!isText(r.text, event === "chat" ? MAX_APP_CHAT_TEXT : undefined)) return bad("bad-text");
    value.text = /** @type {string} */ (r.text);
  }
  if (r.repo !== undefined && (event === "chat" || r.repo !== null)) {
    if (!isRepo(r.repo)) return bad("bad-repo");
    value.repo = r.repo;
  }
  if (event === "send" || event === "pause" || (event === "chat" && r.chat !== undefined)) {
    if (!isChatName(r.chat)) return bad("bad-chat");
    value.chat = /** @type {string} */ (r.chat);
  }
  if (event === "schedule") {
    if (typeof r.schedule !== "string" || !SCHEDULE_ID_RE.test(r.schedule)) return bad("bad-schedule");
    if (typeof r.on !== "boolean") return bad("bad-on");
    value.schedule = r.schedule;
    value.on = r.on;
  }
  // Checked against the allowlist when it runs, so a bad set of picks is answered refused, not dropped unanswered.
  if (event === "models") {
    value.models = r.models;
    value.base = r.base;
  }
  if (event === "job") {
    const job = validJobAction(r.job);
    if (!job) return bad("bad-job");
    value.job = job;
  }
  if (event === "issue") {
    if (typeof r.repo !== "string" || !repoAllowlist().includes(r.repo)) return bad("bad-repo");
    if (!isPr(r.issue)) return bad("bad-issue");
    if (r.op !== "comment" && r.op !== "close" && r.op !== "label") return bad("bad-op");
    if (r.op === "label" ? r.text !== undefined : !isText(r.text, MAX_ISSUE_TEXT)) return bad("bad-text");
    value.repo = r.repo;
    value.issue = /** @type {number} */ (r.issue);
    value.op = r.op;
    if (r.op !== "label") value.text = /** @type {string} */ (r.text);
  }
  return { ok: true, value };
}

/**
 * The server's list of actions it has no final status for.
 * @param {unknown} raw
 * @returns {{ id: string, kind: string }[] | null}
 */
export function validateOutstanding(raw) {
  if (!isRecord(raw)) return null;
  const list = /** @type {Record<string, unknown>} */ (raw).actions;
  if (!Array.isArray(list) || list.length > MAX_OUTSTANDING) return null;
  const out = [];
  for (const item of list) {
    if (!isRecord(item) || !isId(item.id) || typeof item.kind !== "string" || !OUTSTANDING_KINDS.has(item.kind)) return null;
    out.push({ id: /** @type {string} */ (item.id), kind: item.kind });
  }
  return out;
}

/**
 * A name for a chat the runner starts for a message that names no running chat.
 * @param {string} id the message id
 */
export const newChatName = (id) => `chat-${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toLowerCase() || "app"}`;

/**
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number, journal?: ActionJournal, env?: NodeJS.ProcessEnv, holdsFile?: string,
 *   toggle?: typeof toggleSchedule, jobAction?: typeof runJobAction, nodeBin?: string, modelRoutingFile?: string, modelStatusFile?: string,
 *   writePicks?: typeof writePicks }} [options]
 */
export function createCommandFamily(options = {}) {
  const sleep = options.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
  const now = options.now ?? Date.now;
  /** @type {Set<Promise<void>>} */
  const inflight = new Set();
  /** @type {Set<string>} */
  const retrying = new Set();
  /** Actions at work in the background, by id. @type {Set<string>} */
  const running = new Set();
  /** Each job's last action, so its next waits its turn. @type {Map<string, Promise<void>>} */
  const jobQueues = new Map();
  /** Settings' model picks, written one after another. @type {Promise<void>} */
  let modelsQueue = Promise.resolve();
  /** @type {ActionJournal | null} */
  let journal = options.journal ?? null;
  /** @param {ActionContext} ctx */
  const journalOf = (ctx) => (journal ??= new ActionJournal(path.join(path.dirname(ctx.deps.state.file), "actions.json")));

  /**
   * @param {ActionContext} ctx
   * @param {string} id
   * @param {import("../journal.mjs").Report} report
   */
  async function post(ctx, id, report) {
    const { origin, token, log } = ctx.deps;
    try {
      const res = await ctx.deps.fetch(`${origin}/api/bridge/action-ack`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(report.detail ? { id, status: report.status, detail: report.detail } : { id, status: report.status }),
        redirect: "error",
        signal: AbortSignal.timeout(COMMAND_TIMEOUTS.http),
      });
      await res.body?.cancel().catch(() => {});
      // A 404 means the server has no such action any more: there is nothing to retry.
      if (!res.ok && res.status !== 404) throw new Error(`action ack http ${res.status}`);
      return true;
    } catch (err) {
      log("action-ack-failed", { id, status: report.status, error: short(err) });
      return false;
    }
  }

  /**
   * Reports an action's status. The report is journalled first; one that does not
   * reach the server is retried with backoff until it does or a newer one replaces it.
   * @param {ActionContext} ctx
   * @param {string} id
   * @param {string} status
   * @param {Record<string, unknown>} [detail]
   */
  async function ack(ctx, id, status, detail) {
    const report = detail ? { status, detail: fitAckDetail(detail), shaped: true } : { status, shaped: true };
    const book = journalOf(ctx);
    book.report(id, report);
    if (await post(ctx, id, report)) {
      book.acked(id, report);
      return true;
    }
    if (book.get(id)) retryLater(ctx, id);
    return false;
  }

  /** @param {ActionContext} ctx @param {string} id */
  function retryLater(ctx, id) {
    if (retrying.has(id)) return;
    retrying.add(id);
    track(
      (async () => {
        try {
          for (let attempt = 0; attempt < ACK_RETRY_TRIES; attempt++) {
            await sleep(Math.min(ACK_RETRY_BASE_MS * 2 ** attempt, ACK_RETRY_MAX_MS));
            // A newer report can be journalled while an older one is in flight; keep
            // going until the latest one is the one the server has.
            for (;;) {
              const entry = journalOf(ctx).get(id);
              if (!entry?.last || entry.acked) return;
              const report = entry.last;
              if (!(await post(ctx, id, report))) break;
              journalOf(ctx).acked(id, report);
            }
          }
        } finally {
          retrying.delete(id);
        }
      })(),
    );
  }

  /** @param {Promise<void>} work */
  function track(work) {
    const tracked = work.finally(() => inflight.delete(tracked));
    inflight.add(tracked);
  }

  /** @param {string} id @param {Promise<void>} work */
  function background(id, work) {
    running.add(id);
    track(work.finally(() => running.delete(id)));
  }

  /**
   * Answers the server's list of unfinished actions after a reconnect: the last report again, or why there is none.
   * @param {ActionContext} ctx
   * @param {{ id: string, kind: string }[]} actions
   */
  async function outstanding(ctx, actions) {
    const book = journalOf(ctx);
    let picksAnswered = false;
    for (const { id, kind } of actions) {
      if (running.has(id)) continue;
      picksAnswered ||= kind === "models";
      const entry = book.get(id);
      const typed = ctx.deps.state.get(`${kind}-${id}`);
      book.start(id, kind, new Date(now()).toISOString());
      if (entry?.last && DONE.has(entry.last.status)) await ack(ctx, id, entry.last.status, entry.last.shaped === true ? entry.last.detail : legacyDetail(entry.last.detail));
      else if (typed) await ack(ctx, id, typed.delivery.confirmed ? "typed" : "unconfirmed");
      else if (entry && kind === "models" && (await currentBase(options.modelRoutingFile)) === id)
        // The restart came after the picks file took this save, so it is in force.
        await ack(ctx, id, "succeeded", { reason: savedReason(options.modelRoutingFile) });
      else if (entry && kind === "models") await ack(ctx, id, "failed", { reason: "the Mac restarted while saving these picks; check Settings before trying again" });
      else if (entry) {
        const check = kind === "schedule" ? "the Schedules tab" : kind === "job" ? "the job" : "the chat";
        await ack(ctx, id, "failed", { reason: `the Mac restarted during this action; check ${check} before trying again` });
      }
      else await ack(ctx, id, "failed", { reason: "the Mac never received this action; nothing was run", unseen: true });
      ctx.deps.log("outstanding-answered", { id, kind });
    }
    // The connect's own report can land before these acks, and Settings opens again only on one the server takes after.
    if (picksAnswered)
      await sendModelReport(ctx.deps, { file: options.modelRoutingFile, statusFile: options.modelStatusFile }).catch((err) =>
        ctx.deps.log("models-report-failed", { error: short(err) }),
      );
  }

  /**
   * Types a worker sheet line into its chat; pause interrupts the chat first.
   * @param {ActionContext} ctx
   * @param {{ id: string, repo?: string, chat: string }} v
   * @param {"send" | "pause"} kind
   * @param {string} line
   * @returns {Promise<ActionResult>}
   */
  async function typeInto(ctx, v, kind, line) {
    const { state, log } = ctx.deps;
    const key = `${kind}-${v.id}`;
    const seen = state.get(key);
    if (seen) return (await ack(ctx, v.id, seen.delivery.confirmed ? "typed" : "unconfirmed")) ? "duplicate" : "ack-failed";
    let handle;
    try {
      const found = resolveChatTerminal(await ctx.listTerminals(), v.chat, v.repo ?? null);
      if (!found.handle) {
        log(`${kind}-skipped`, { id: v.id, chat: v.chat, reason: found.reason });
        await ack(ctx, v.id, "failed", { reason: found.reason === "ambiguous" ? "that name matches more than one chat" : "that chat is not running" });
        return "delivered";
      }
      handle = found.handle;
    } catch (err) {
      log("chat-list-failed", { id: v.id, error: short(err) });
      await ack(ctx, v.id, "failed", { reason: "could not list the chats on the Mac" });
      return "delivered";
    }
    if (kind === "pause") {
      try {
        await ctx.deps.chatRunner.interrupt(handle);
      } catch (err) {
        log("interrupt-failed", { id: v.id, chat: v.chat, error: short(err) });
      }
    }
    let receipt;
    try {
      receipt = await ctx.sendLine(handle, line);
    } catch (err) {
      log(`${kind}-failed`, { id: v.id, chat: v.chat, error: short(err) });
      await ack(ctx, v.id, "failed", { reason: "typing into that chat failed" });
      return "delivered";
    }
    const at = new Date(now()).toISOString();
    state.put({
      id: key,
      itemId: v.id,
      processedAt: at,
      delivery: { target: "chat", chat: v.chat, at, confirmed: receipt.confirmed, stages: receipt.stages },
      acked: false,
    });
    log(`${kind}-typed`, { id: v.id, chat: v.chat, confirmed: receipt.confirmed });
    if (!(await ack(ctx, v.id, receipt.confirmed ? "typed" : "unconfirmed"))) return "ack-failed";
    state.put({ ...state.get(key), acked: true });
    return "delivered";
  }

  /**
   * A chat message from the app, typed once only: into the running chat it names, else the monitor chat when one is
   * set and running, else a new chat the runner starts with it as the first message. A failed list or send ends the connection, so
   * the server replays it.
   * @param {ActionContext} ctx
   * @param {{ id: string, repo?: string, chat?: string, text?: string, image?: string, images?: string[], files?: import("../validate.mjs").FileRef[], replyTo?: string, quote?: import("../command-templates.mjs").Quote, conversation?: import("../command-templates.mjs").Conversation }} v
   * @returns {Promise<ActionResult>}
   */
  async function chat(ctx, v) {
    const { state, log, monitorChat } = ctx.deps;
    const key = `chat-${v.id}`;
    const seen = state.get(key);
    if (seen) {
      log("duplicate", { id: key });
      return (await ack(ctx, v.id, chatAckStatus(seen.delivery))) ? "duplicate" : "ack-failed";
    }
    /** @type {import("../images.mjs").Attachment[]} */
    const attachments = [];
    for (const image of v.images ?? (v.image ? [v.image] : [])) {
      /** @type {import("../images.mjs").Attachment} */
      let attachment;
      try {
        attachment = await fetchImage(ctx.deps, image);
      } catch (err) {
        log("image-failed", { id: key, error: short(err) });
        return "delivery-failed";
      }
      if ("unavailable" in attachment) log("image-unavailable", { id: key, reason: attachment.unavailable });
      attachments.push(attachment);
    }
    const line = appChatLine(v.id, v.text, attachments, v.files, v.replyTo ? { replyTo: v.replyTo, quote: v.quote } : undefined, v.conversation);
    /** @type {{ target: "chat" | "rivet" | "new", chat: string }} */
    let route;
    let handle = null;
    try {
      const terminals = v.chat || monitorChat ? await ctx.listTerminals() : [];
      if (v.chat) handle = resolveChatTerminal(terminals, v.chat, v.repo ?? null).handle;
      if (handle) route = { target: "chat", chat: handle };
      else {
        const monitor = monitorChat ? resolveChatTerminal(terminals, monitorChat).handle : null;
        route = monitor ? { target: "rivet", chat: monitor } : { target: "new", chat: newChatName(v.id) };
      }
    } catch (err) {
      log("chat-list-failed", { id: key, error: short(err) });
      return "delivery-failed";
    }
    let receipt;
    try {
      if (route.target === "new") {
        await ctx.deps.chatRunner.start(route.chat, line);
        receipt = { confirmed: true, stages: ["started"] };
      } else receipt = await ctx.sendLine(route.chat, line);
    } catch (err) {
      log("delivery-failed", { id: key, chat: route.chat, error: short(err) });
      return "delivery-failed";
    }
    const at = new Date(now()).toISOString();
    state.put({
      id: key,
      itemId: v.id,
      processedAt: at,
      delivery: { target: route.target === "rivet" ? "rivet" : "chat", chat: route.chat, at, confirmed: receipt.confirmed, stages: receipt.stages },
      acked: false,
    });
    log("chat-typed", { id: key, chat: route.chat, target: route.target, confirmed: receipt.confirmed });
    if (!(await ack(ctx, v.id, chatAckStatus(receipt)))) return "ack-failed";
    state.put({ ...state.get(key), acked: true });
    return "delivered";
  }

  /**
   * The merge from a card (./merge.mjs). A repeat of an answered tap only repeats the answer, and one that reached the
   * merge command before a restart reports what GitHub shows without running it again.
   * @param {ActionContext} ctx @param {{ id: string, repo: string, pr: number, headSha: string }} v
   * @returns {Promise<ActionResult>}
   */
  async function merge(ctx, v) {
    const { log, exec, ghBin } = ctx.deps;
    const book = journalOf(ctx);
    const entry = book.get(v.id);
    if (entry?.last && DONE.has(entry.last.status)) return (await ack(ctx, v.id, entry.last.status, entry.last.detail)) ? "duplicate" : "ack-failed";
    const answer = await runMerge({ exec, ghBin, env: options.env, holdsFile: options.holdsFile, now: now(), tried: entry?.note?.mergeTried === true, beforeMerge: () => book.note(v.id, { mergeTried: true }) }, v);
    log(`merge-${answer.status}`, { id: v.id, pr: v.pr, reason: answer.detail.reason });
    return (await ack(ctx, v.id, answer.status, answer.detail)) ? "delivered" : "ack-failed";
  }

  /**
   * Turns one schedule on or off (schedules/toggle.mjs), then sends the Schedules tab a fresh read.
   * @param {ActionContext} ctx
   * @param {{ id: string, schedule: string, on: boolean }} v
   */
  async function schedule(ctx, v) {
    const { log } = ctx.deps;
    let result;
    try {
      result = await (options.toggle ?? toggleSchedule)(ctx.deps, v.schedule, v.on);
    } catch (err) {
      log("schedule-failed", { id: v.id, error: short(err) });
      result = { status: /** @type {const} */ ("failed"), reason: `could not switch it: ${short(err)}` };
    }
    log("schedule-switched", { id: v.id, schedule: v.schedule, on: v.on, status: result.status });
    await ack(ctx, v.id, result.status, { reason: shapeText(result.reason, 300) });
    wakeSchedules();
  }

  /**
   * A job (jobs.mjs): made, switched, run or removed. One job's actions run in the order they came, so a later resume is
   * never overtaken by an earlier pause still editing; an action already answered is answered again, never done twice.
   * @param {ActionContext} ctx
   * @param {{ id: string, job: import("../jobs.mjs").JobAction }} v
   */
  function job(ctx, v) {
    const key = v.job.id;
    const turn = (jobQueues.get(key) ?? Promise.resolve()).then(() => jobOnce(ctx, v));
    const tail = turn.catch(() => {});
    jobQueues.set(key, tail);
    void tail.then(() => {
      if (jobQueues.get(key) === tail) jobQueues.delete(key);
    });
    return turn;
  }

  /** @param {ActionContext} ctx @param {{ id: string, job: import("../jobs.mjs").JobAction }} v */
  async function jobOnce(ctx, v) {
    const { log } = ctx.deps;
    const done = journalOf(ctx).get(v.id)?.last;
    if (done && DONE.has(done.status)) {
      await ack(ctx, v.id, done.status, done.detail);
      return;
    }
    const result = await (options.jobAction ?? runJobAction)({ exec: ctx.deps.exec, nodeBin: options.nodeBin ?? process.execPath, log }, v.job, v.id);
    log("job-action", { id: v.id, job: v.job.id, op: v.job.op, status: result.status });
    await ack(ctx, v.id, result.status, { reason: shapeText(result.reason, 300) });
  }

  /**
   * Settings › Who does what (model-routing.mjs): the picks checked against config/model-jobs.json again, written to
   * the Mac's file only over the save the screen last saw (`base`) and read back, the file reported to the server, then
   * acked. Writes run one at a time, in the order they came; an action already answered is answered again, never rerun.
   * @param {ActionContext} ctx
   * @param {{ id: string, models?: unknown, base?: unknown }} v
   */
  function models(ctx, v) {
    const turn = modelsQueue.then(() => modelsOnce(ctx, v));
    modelsQueue = turn.catch(() => {});
    return turn;
  }

  /** @param {ActionContext} ctx @param {{ id: string, models?: unknown, base?: unknown }} v */
  async function modelsOnce(ctx, v) {
    const { log } = ctx.deps;
    const done = journalOf(ctx).get(v.id)?.last;
    if (done) {
      log("models-repeat", { id: v.id, status: done.status });
      await ack(ctx, v.id, done.status, done.detail);
      return;
    }
    const files = { file: options.modelRoutingFile, statusFile: options.modelStatusFile };
    const report = () => sendModelReport(ctx.deps, files).catch((err) => log("models-report-failed", { id: v.id, error: short(err) }));
    const picks = validPicks(v.models);
    const refusal = picks ? await baseRefusal(v.base, files.file) : "These picks are not on the allowed list for every job, so nothing was written.";
    if (!picks || refusal) {
      log("models-refused", { id: v.id });
      await ack(ctx, v.id, "refused", { reason: refusal ?? "" });
      // Settings opens again only on a report the server takes after this ack.
      await report();
      return;
    }
    let result = await (options.writePicks ?? writePicks)(picks, { file: files.file, action: v.id, now: () => new Date(now()) });
    // A step after the rename failed (flushing the folder, reading back), yet the file holds this save, so it is in force.
    if (result.status !== "succeeded" && (await currentBase(files.file)) === v.id) result = { status: "succeeded", reason: savedReason(files.file) };
    log("models-written", { id: v.id, status: result.status });
    // Reported before the ack: Settings says Saved only once the server's report carries this action.
    await report();
    await ack(ctx, v.id, result.status, { reason: result.reason });
    if (result.status !== "succeeded") await report();
  }

  /**
   * Why a save is turned away before anything is written: the file moved on from the one the screen saw (another
   * screen saved first), or can't be read to tell.
   * @param {unknown} base
   * @param {string | undefined} file
   */
  async function baseRefusal(base, file) {
    if (base !== null && typeof base !== "string") return "This save didn't say which picks it was changed from, so nothing was written.";
    const current = await currentBase(file);
    if (current === undefined) return "Can't read the Mac's picks file, so nothing was written.";
    if (base !== current) return "Changed on another screen first, so nothing was written. Showing the latest.";
    return null;
  }

  /**
   * A backlog issue's Start work label, or a comment or close, on a repo in RIVET_REPOS, made with the Mac's own gh login,
   * the owner's words on stdin. The journal notes each step, so the same action sent again is answered, never run twice:
   * one a restart stopped mid-comment or mid-close is reported, not retried, as it may have gone. The journal keeps a hash
   * of the request it started with, so the id sent again with another issue, op or words is refused.
   * @param {ActionContext} ctx
   * @param {{ id: string, repo: string, issue: number, op: "comment" | "close" | "label", text?: string }} v
   * @param {import("../journal.mjs").JournalEntry | undefined} before its journal entry from before this delivery
   */
  async function issueWrite(ctx, v, before) {
    const { log, exec, ghBin } = ctx.deps;
    const request = createHash("sha256").update(JSON.stringify([v.repo, v.issue, v.op, v.text])).digest("hex");
    if (before && (before.kind !== "issue" || (before.note?.request !== undefined && before.note.request !== request))) {
      log("issue-mismatch", { id: v.id, issue: v.issue, op: v.op });
      await ack(ctx, v.id, "failed", { reason: "This write's id was already used for another; nothing was done" });
      return;
    }
    if (before?.last && DONE.has(before.last.status)) {
      log("issue-repeat", { id: v.id, status: before.last.status });
      await ack(ctx, v.id, before.last.status, before.last.detail);
      return;
    }
    const note = before?.note ?? {};
    // A label added twice is the same label, so one a restart stopped mid-step is simply done again.
    if (note.commenting === true && note.commented !== true) {
      await ack(ctx, v.id, "failed", { reason: `the Mac restarted while commenting; check #${v.issue} on GitHub before trying again` });
      return;
    }
    if (note.closing === true && note.closed !== true) {
      await ack(ctx, v.id, "failed", { reason: `Commented, but the Mac restarted while closing; check #${v.issue} on GitHub` });
      return;
    }
    const book = journalOf(ctx);
    const issue = String(v.issue);
    if (note.request === undefined) book.note(v.id, { request });
    try {
      if (v.op === "label") {
        book.note(v.id, { labelling: true });
        try {
          await exec(ghBin, ["label", "create", WORKING_LABEL, "--repo", v.repo, "--color", "FBCA04", "--description", "A chat is working on this"], { timeout: COMMAND_TIMEOUTS.gh });
        } catch (err) {
          if (!/already exists/i.test(short(err, true))) throw err;
        }
        // Assigned too, so an agent that takes only unassigned issues never starts a second worker on it.
        await exec(ghBin, ["issue", "edit", issue, "--repo", v.repo, "--add-label", WORKING_LABEL, "--add-assignee", "@me"], { timeout: COMMAND_TIMEOUTS.gh });
        book.note(v.id, { labelled: true });
      } else if (note.commented !== true) {
        // A close whose comment went but whose close failed is tried again as a new action: it closes without a second comment.
        const target = `${v.repo}#${v.issue}`;
        const said = v.op === "close" && [...book.entries.values()].some((one) => one.note?.closeCommented === target);
        if (!said) {
          book.note(v.id, { commenting: true });
          await exec(ghBin, ["issue", "comment", issue, "--repo", v.repo, "--body-file", "-"], { timeout: COMMAND_TIMEOUTS.gh, input: v.text });
        }
        book.note(v.id, v.op === "close" ? { commented: true, closeCommented: target } : { commented: true });
      }
      if (v.op === "close" && note.closed !== true) {
        book.note(v.id, { closing: true });
        await exec(ghBin, ["issue", "close", issue, "--repo", v.repo, "--reason", "not planned"], { timeout: COMMAND_TIMEOUTS.gh });
        book.note(v.id, { closed: true });
      }
    } catch (err) {
      log("issue-failed", { id: v.id, issue: v.issue, op: v.op, error: short(err) });
      const commented = journalOf(ctx).get(v.id)?.note?.commented === true;
      const said = v.op === "label" ? "GitHub refused the label" : commented ? "Commented, but GitHub would not close it" : "GitHub refused the comment";
      await ack(ctx, v.id, "failed", { reason: `${said}: ${short(err, true)}` });
      return;
    }
    log("issue-written", { id: v.id, issue: v.issue, op: v.op });
    await ack(ctx, v.id, "succeeded", { reason: v.op === "label" ? `Labelled #${v.issue} ${WORKING_LABEL}` : v.op === "close" ? `Commented on and closed #${v.issue}` : `Commented on #${v.issue}` });
  }

  return {
    family: "command",
    events: Object.freeze(["chat", "send", "pause", "merge", "schedule", "job", "issue", "models", "actions.outstanding"]),
    /**
     * @param {string} event
     * @param {unknown} raw
     * @param {ActionContext} ctx
     * @returns {Promise<ActionResult>}
     */
    async handle(event, raw, ctx) {
      if (event === "actions.outstanding") {
        const actions = validateOutstanding(raw);
        if (!actions) {
          ctx.deps.log("drop", { event, reason: "bad-outstanding" });
          return "dropped";
        }
        await outstanding(ctx, actions);
        return "delivered";
      }
      const v = validateCommand(event, raw);
      if (!v.ok) {
        ctx.deps.log("drop", { id: v.id, event, reason: v.reason });
        if (event !== "merge" || v.id === "?") return "dropped";
        journalOf(ctx).start(v.id, event, new Date(now()).toISOString());
        return (await ack(ctx, v.id, "refused", { reason: `the merge request was not well formed (${v.reason})` })) ? "delivered" : "ack-failed";
      }
      const value = /** @type {any} */ (v.value);
      // The server sends a GitHub write again on every attach until it has an answer.
      if (event === "issue" && running.has(value.id)) return "duplicate";
      const before = event === "issue" ? journalOf(ctx).get(value.id) : undefined;
      if (event !== "chat") journalOf(ctx).start(value.id, event, new Date(now()).toISOString());
      switch (event) {
        case "chat":
          return chat(ctx, value);
        case "send":
          return typeInto(ctx, value, "send", sendToChatLine(value.text));
        case "pause":
          return typeInto(ctx, value, "pause", PAUSE_LINE);
        case "merge":
          return merge(ctx, value);
        case "schedule":
          background(value.id, schedule(ctx, value));
          return "delivered";
        case "job":
          background(value.id, job(ctx, value));
          return "delivered";
        case "models":
          background(value.id, models(ctx, value));
          return "delivered";
        case "issue":
          background(value.id, issueWrite(ctx, value, before));
          return "delivered";
        default:
          return "dropped";
      }
    },
    /** Resolves once every action and ack retry in flight has finished. */
    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}

/**
 * @param {unknown} err
 * @param {boolean} [withStderr] only for gh, whose stderr never echoes owner text
 */
export function short(err, withStderr = false) {
  const e = /** @type {any} */ (err);
  const first = withStderr && typeof e?.stderrFirstLine === "string" && e.stderrFirstLine ? `: ${e.stderrFirstLine}` : "";
  return shapeText(`${e?.message ?? "error"}${first}`, 200);
}

export const command = createCommandFamily();
