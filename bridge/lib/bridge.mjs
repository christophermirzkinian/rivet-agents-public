import { ACTION_FAMILIES, actionTable } from "./actions/index.mjs";
import { newChatName } from "./actions/command.mjs";
import { fetchImage } from "./images.mjs";
import { SseParser } from "./sse.mjs";
import { LEGACY_ERROR, StateStore } from "./state.mjs";
import { chatLine, field, githubCommentBody, githubTarget, replyMarker, sanitizeLine } from "./templates.mjs";
import { resolveChatTerminal } from "./terminals.mjs";
import { isChatName, validateReply } from "./validate.mjs";
import { ASK_ID_RE } from "./asks.mjs";
import { workerSnapshot } from "./workers.mjs";
import { putSnapshot } from "./snapshot-compat.mjs";
import { createWorkRepos } from "./work-repo.mjs";
import { redactKeepingLines, shapeText } from "./redact-cut.mjs";
import { holdDialogUp } from "./delivery-proof.mjs";
import { readMergeHolds } from "./merge-holds.mjs";
import { OPS_STATUS_KEY_RE, OPS_STATUS_KINDS } from "./ops-status.mjs";
import { defaultRepo, isRepo, repoAllowlist } from "../../src/shared/repos.ts";

/** @typedef {import("./config.mjs").Exec} Exec */
/** @typedef {import("./validate.mjs").Reply} Reply */
/** @typedef {import("./templates.mjs").GithubResult} GithubResult */
/** @typedef {import("./templates.mjs").Route} Route */

export const TIMEOUTS = Object.freeze({ gh: 30_000, http: 15_000, prHolds: 60_000 });
/** A pick-up older than this is left for the server's next tick, which reads the item again. */
const PICKUP_STALE_MS = 9 * 60_000;
export const IDLE_MS = 45_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const UNAUTHORIZED_MS = 5 * 60_000;
export const WORKERS_INTERVAL_MS = 20_000;
/** Waits before each retry of a failed chat list: a busy runner times out now and then. */
export const LIST_RETRY_MS = Object.freeze([500, 1_500]);
/**
 * How long a line waits for a held-message dialog to go. Past this the line is typed anyway: text that only looks like
 * the dialog must not stop a line for good.
 */
export const HOLD_WAIT_MS = 450_000;
export const HOLD_POLL_MS = 5_000;
/**
 * Sent on the event stream request so the server knows what this bridge takes: photos, whole chat windows, several
 * photos per chat message, long chat windows (up to 20,000 characters typed), documents (named in the line, fetched with
 * scripts/attachments.mjs), a merge-ready card's arming answer and a Dismiss (no GitHub comment for either), late asks,
 * the owner's Reopen, the auto pick-up and the Home page's buttons.
 */
export const FEATURES = "image,chat-window,long-chat,images,files,reply-images,card-merge,dismiss,choice-detail,ask-late,changes,reopen,ops-pickup,home-control";
/** Queued events an app chat line may go ahead of: the server re-sends them on reconnect. */
const OVERTAKABLE = new Set(["reply"]);
/**
 * Events handled as they arrive, outside the delivery queue: a sheet's live log only starts or stops a background read
 * (actions/logs.mjs) and never types into a chat. Queued, a held reply would keep it past its lease.
 */
const UNQUEUED = new Set(["logs.subscribe", "logs.unsubscribe"]);
/** The events this file handles itself; the rest go to an action family (actions/index.mjs). */
const BUILT_IN_EVENTS = new Set(["reply", "reopen", "late-ask", "ops-pickup"]);
/** Chat lines in a row that may pass the same waiting card answer. */
const OVERTAKE_LIMIT = 3;

const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._/-]+#issuecomment-\d+$/;

/**
 * @param {number} attempt consecutive failures so far
 * @param {() => number} [random]
 */
export function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 10));
  return base + Math.floor(random() * 1000);
}

/**
 * @typedef {{
 *   origin: string, token: string, ghBin: string, gitBin?: string | null, workRepos?: (worker: { chat: string, repo: string }) => Promise<string | undefined>,
 *   monitorChat: string | null, chatRunner: import("./chat-source.mjs").ChatRunner,
 *   exec: Exec, fetch: typeof fetch, state: StateStore,
 *   log: (event: string, fields?: Record<string, unknown>) => void,
 *   now?: () => Date, idleMs?: number, listRetryMs?: readonly number[], holdWaitMs?: number, holdPollMs?: number,
 *   prHolds?: (repo: string, pr: number) => Promise<string[]>,
 *   actions?: readonly import("./actions/index.mjs").ActionFamily[],
 * }} BridgeDeps
 */

/**
 * @param {unknown} err
 * @param {boolean} [withStderr] only for gh, whose stderr never echoes the comment body
 */
function short(err, withStderr = false) {
  const e = /** @type {any} */ (err);
  const first =
    withStderr && typeof e?.stderrFirstLine === "string" && e.stderrFirstLine ? `: ${e.stderrFirstLine}` : "";
  // Redacted whole, then cut: a failed decision comment's error is stored and sent to Rivet as github.error.
  return shapeText(`${e?.message ?? "error"}${first}`, 200);
}


/**
 * The GitHub result an ack sends for a saved entry. A decision-comment error saved before short() redacted it,
 * unmarked, was cut before any redaction and may hold a token's cut-off head no redaction can recognise: fixed words go
 * in its place (StateStore.load scrubs those on disk the same way).
 * @param {import("./state.mjs").StateEntry} entry
 */
function githubOf(entry) {
  const github = entry.github;
  if (!github || !("error" in github)) return github;
  return { error: entry.shaped ? shapeText(github.error, 200) : LEGACY_ERROR };
}

/**
 * The monitor chat's line asking a late ask's chat (kind "ask", key the ask's id) what held it up: this bridge's own
 * sentence around the ask's id, chat and due time, each checked here. Null for a kind, key, chat or time it does not know.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function lateAskLine(raw) {
  const r = /** @type {any} */ (raw && typeof raw === "object" ? raw : {});
  if (r.kind !== "ask" || typeof r.key !== "string" || !ASK_ID_RE.test(r.key)) return null;
  if (typeof r.dueAt !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]{5,12}(?:Z|[+-]\d{2}:\d{2})$/.test(r.dueAt)) return null;
  const who = r.chat === undefined ? "No chat is named on it, so find who has it." : isChatName(r.chat) ? `Ask chat ${r.chat} what held it up.` : null;
  if (who === null) return null;
  // An ask's time is the server's: one new time with its reason, which it keeps as a move.
  return `Rivet: ask ${r.key} ran past its done-by time (${r.dueAt}). ${who} Then give it a new time and the cause: rivet ask set ${r.key} --due "<new time>" --why "<cause>". When it is done: rivet ask set ${r.key} --stage done.`;
}

/**
 * The monitor chat's line for the server's auto pick-up: this bridge's own sentence around the item's kind, key and repo,
 * each checked here. Null for one it does not know.
 * @param {unknown} kind @param {unknown} key @param {unknown} repo
 * @returns {string | null}
 */
export function opsPickupLine(kind, key, repo) {
  if (typeof kind !== "string" || kind === "coming" || !OPS_STATUS_KINDS.includes(kind)) return null;
  if (typeof key !== "string" || !OPS_STATUS_KEY_RE.test(key)) return null;
  if (typeof repo !== "string" || !repoAllowlist().includes(repo)) return null;
  const flag = repo === defaultRepo() ? "" : ` --repo ${repo}`;
  return `Rivet auto pick-up: ${kind} ${key} is red with nobody on it. Run rivet fix ${kind} ${key}${flag} --by rivet (no card for the owner).`;
}

const REOPEN_WORDS = { approve: "APPROVED", reject: "REJECTED", done: "DONE", dismiss: "DISMISSED", comment: "COMMENT" };

/**
 * The line for the owner's Reopen of an answered card: this bridge's own sentence around the card's id, title, chat and
 * time and the earlier answer, each checked here; the title sits inside double quotes as data. Null for a field this bridge does
 * not know. `direct`: typed into the card's own chat rather than passed on to it.
 * @param {unknown} raw
 * @param {boolean} [direct]
 * @returns {string | null}
 */
export function reopenLine(raw, direct = false) {
  const r = /** @type {any} */ (raw && typeof raw === "object" ? raw : {});
  if (typeof r.itemId !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(r.itemId)) return null;
  if (typeof r.title !== "string" || !r.title.trim()) return null;
  if (typeof r.at !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]{5,12}(?:Z|[+-]\d{2}:\d{2})$/.test(r.at)) return null;
  if (r.chat !== undefined && !isChatName(r.chat)) return null;
  if (r.repo !== undefined && r.repo !== null && !isRepo(r.repo)) return null;
  const earlier = r.earlier && typeof r.earlier === "object" ? r.earlier : {};
  if (typeof earlier.replyId !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(earlier.replyId)) return null;
  const was =
    earlier.decision === "choice" && typeof earlier.choice === "string"
      ? `CHOSE "${field(earlier.choice, 200)}"`
      : REOPEN_WORDS[/** @type {keyof typeof REOPEN_WORDS} */ (earlier.decision)];
  if (!was) return null;
  const who = direct
    ? "This is your card: hold off acting on that answer."
    : r.chat === undefined
      ? "The card names no chat: hold off acting on that answer yourself."
      : `For chat ${r.chat}: tell that chat to hold off acting on that answer.`;
  const repo = !r.repo || r.repo === defaultRepo() ? "" : ` Repo: ${r.repo}.`;
  return `Rivet app — owner REOPENED card [${r.itemId}] at ${r.at}: the earlier answer (${was}, reply ${earlier.replyId}) no longer stands; the new answer follows as a change of it. ${who}${repo} Card title (board data): "${field(r.title, 300)}".`;
}

/**
 * @param {BridgeDeps} deps
 */
export function createBridge(deps) {
  const { origin, token, ghBin, monitorChat, chatRunner, exec, state, log } = deps;
  const fetchFn = deps.fetch;
  const now = deps.now ?? (() => new Date());
  const idleMs = deps.idleMs ?? IDLE_MS;
  const retryMs = deps.listRetryMs ?? LIST_RETRY_MS;
  const holdWaitMs = deps.holdWaitMs ?? HOLD_WAIT_MS;
  const holdPollMs = deps.holdPollMs ?? HOLD_POLL_MS;
  const pause = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const auth = { authorization: `Bearer ${token}` };
  // Registration point for action families: bridge/lib/actions/index.mjs.
  const actions = actionTable(deps.actions ?? ACTION_FAMILIES);
  const gitBin = deps.gitBin;
  const workRepos = deps.workRepos ?? (gitBin ? createWorkRepos({ exec, git: () => gitBin }) : null);
  // A draft is held too: `rivet hold` turns the PR into a draft.
  const prHolds = deps.prHolds ?? (async (/** @type {string} */ repo, /** @type {number} */ pr) => {
    const read = await readMergeHolds({ repo, pr, shown: redactKeepingLines, forMerge: false,
      gh: async (args) => (await exec(ghBin, args, { timeout: TIMEOUTS.gh, maxBuffer: 32 * 1024 * 1024 })).stdout });
    return read.view?.draft === true ? [...read.holds, "draft"] : read.holds;
  });

  /**
   * The runner's chats, retried before a failure counts: a failed list ends the connection.
   * @returns {Promise<import("./terminals.mjs").Terminal[]>}
   */
  async function listTerminals() {
    for (const wait of retryMs) {
      try {
        return await chatRunner.list();
      } catch (err) {
        log("chat-list-retry", { error: short(err) });
        await pause(wait);
      }
    }
    return chatRunner.list();
  }

  /**
   * The chat's screen, or null when it cannot be read.
   * @param {string} handle
   * @returns {Promise<string[] | null>}
   */
  async function readScreen(handle) {
    try {
      return await chatRunner.read(handle, 40);
    } catch {
      return null;
    }
  }

  /**
   * Holds a line back while a held-message dialog is up, or it would be typed into the dialog. It waits here, not on a
   * reconnect, so what comes after it stays behind it.
   * @param {string} handle
   * @returns {Promise<unknown[] | null>} the last screen read
   */
  async function waitOutHold(handle) {
    const until = now().getTime() + holdWaitMs;
    let tail = await readScreen(handle);
    if (!tail || !holdDialogUp(tail)) return tail;
    log("hold-dialog-wait", { handle });
    while (tail && holdDialogUp(tail) && now().getTime() < until) {
      await pause(holdPollMs);
      tail = await readScreen(handle);
    }
    if (tail && holdDialogUp(tail)) log("hold-dialog-still-up", { handle });
    return tail;
  }

  /**
   * Types one line into a runner chat once the held-message dialog is gone, and presses Enter. A line the runner took
   * counts as delivered and is never typed again: a duplicate decision in a chat is worse than an unconfirmed one.
   * @param {string} handle the chat's name
   * @param {string} line
   * @returns {Promise<{ confirmed: boolean, stages: string[] }>}
   */
  async function sendLine(handle, line) {
    await waitOutHold(handle);
    return chatRunner.send(handle, line);
  }

  /**
   * Where a line for a card's chat goes: that chat when it is running, else the monitor chat when one is set and
   * running. Null when neither is.
   * @param {import("./terminals.mjs").Terminal[]} terminals
   * @param {string | undefined} chat
   * @param {string | null | undefined} repo
   * @returns {{ handle: string, direct: boolean } | null}
   */
  function routeOf(terminals, chat, repo) {
    const own = chat ? resolveChatTerminal(terminals, chat, repo ?? null).handle : null;
    if (own) return { handle: own, direct: true };
    const monitor = monitorChat ? resolveChatTerminal(terminals, monitorChat).handle : null;
    return monitor ? { handle: monitor, direct: false } : null;
  }

  /**
   * @param {Reply} reply
   * @param {number} number
   * @returns {Promise<GithubResult>}
   */
  async function postDecision(reply, number) {
    // GitHub writes go only to a repo in RIVET_REPOS.
    if (!reply.item.repo || !repoAllowlist().includes(reply.item.repo)) throw new Error("repo not in RIVET_REPOS");
    const endpoint = `repos/${reply.item.repo}/issues/${number}/comments`;
    const marker = replyMarker(reply.id);
    const found = await exec(
      ghBin,
      ["api", endpoint, "--paginate", "--jq", `.[] | select(.body | contains(${JSON.stringify(marker)})) | .html_url`],
      { timeout: TIMEOUTS.gh, maxBuffer: 16 * 1024 * 1024 },
    );
    const existing = found.stdout.split("\n").map((l) => l.trim()).find((l) => GITHUB_URL_RE.test(l));
    if (existing) {
      log("github-existing", { id: reply.id });
      return { url: existing };
    }
    const posted = await exec(
      ghBin,
      ["api", "--method", "POST", endpoint, "--input", "-", "--jq", ".html_url"],
      { timeout: TIMEOUTS.gh, input: JSON.stringify({ body: githubCommentBody(reply) }) },
    );
    const url = posted.stdout.trim();
    if (!GITHUB_URL_RE.test(url)) throw new Error("gh returned no comment url");
    log("github-posted", { id: reply.id });
    return { url };
  }

  /**
   * @param {{ id: string, delivery?: object, github?: object, error?: string }} body
   */
  async function ack(body) {
    const res = await fetchFn(`${origin}/api/bridge/ack`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUTS.http),
    });
    await res.body?.cancel().catch(() => {});
    if (!res.ok) throw new Error(`ack http ${res.status}`);
  }

  /** @param {import("./state.mjs").StateEntry} entry */
  async function ackEntry(entry) {
    /** @type {{ id: string, delivery: object, github?: object }} */
    const body = { id: entry.id, delivery: entry.delivery };
    const github = githubOf(entry);
    if (github) body.github = github;
    try {
      await ack(body);
    } catch (err) {
      log("ack-failed", { id: entry.id, error: short(err) });
      return false;
    }
    // Saved again redacted: an entry from before redaction keeps no raw error on disk once its ack lands.
    if (!entry.acked || !entry.shaped) state.put({ ...entry, ...(github ? { github } : {}), shaped: true, acked: true });
    log("acked", { id: entry.id });
    return true;
  }

  /**
   * Handles one reply end to end: into the card's chat when it is running, else the monitor chat, else a new chat the
   * runner starts with it. Returns "delivery-failed" when the line could not be typed, and "ack-failed" when the ack
   * did not land; either way the caller reconnects and the server replays it (a delivered reply is then only re-acked
   * from state).
   * @param {unknown} raw
   * @returns {Promise<"dropped" | "duplicate" | "delivered" | "delivery-failed" | "ack-failed">}
   */
  async function processReply(raw) {
    const v = validateReply(raw);
    if (!v.ok) {
      log("drop", { id: v.id, reason: v.reason });
      return "dropped";
    }
    const reply = v.reply;
    const seen = state.get(reply.id);
    if (seen) {
      log("duplicate", { id: reply.id });
      return (await ackEntry(seen)) ? "duplicate" : "ack-failed";
    }

    /** @type {import("./images.mjs").Attachment[]} */
    const attachments = [];
    for (const image of reply.images ?? (reply.image ? [reply.image] : [])) {
      /** @type {import("./images.mjs").Attachment} */
      let attachment;
      try {
        attachment = await fetchImage(deps, image);
      } catch (err) {
        log("image-failed", { id: reply.id, error: short(err) });
        return "delivery-failed";
      }
      if ("unavailable" in attachment) log("image-unavailable", { id: reply.id, reason: attachment.unavailable });
      attachments.push(attachment);
    }

    /** @type {GithubResult | undefined} */
    let github;
    // An arming answer posts nothing, as a comment after the card would keep the PR from merging; a Dismiss answers
    // nothing: the chat line is the record of both.
    const where = reply.item.merge || reply.decision === "dismiss" ? null : githubTarget(reply);
    if (where) {
      try {
        github = await postDecision(reply, where.number);
      } catch (err) {
        github = { error: short(err, true) };
        log("github-failed", { id: reply.id, error: github.error });
      }
    }

    /** @type {import("./terminals.mjs").Terminal[]} */
    let terminals = [];
    try {
      terminals = await listTerminals();
    } catch (err) {
      log("chat-list-failed", { id: reply.id, error: short(err) });
      return "delivery-failed";
    }

    const chat = reply.item.chat;
    const found = routeOf(terminals, chat, reply.item.repo);
    const handle = found?.handle ?? newChatName(reply.id);
    /** @type {Route} */
    const route = { target: found && !found.direct ? "rivet" : "chat", chat: handle, ...(found?.direct ? {} : { reason: chat ? "relay" : "no-chat" }) };
    const line = chatLine(reply, github, route, attachments);
    /** @type {{ confirmed: boolean, stages: string[] }} */
    let receipt;
    try {
      if (found) receipt = await sendLine(handle, line);
      else {
        await chatRunner.start(handle, line);
        receipt = { confirmed: true, stages: ["started"] };
      }
    } catch (err) {
      log("delivery-failed", { id: reply.id, chat: handle, error: short(err) });
      return "delivery-failed";
    }
    const at = now().toISOString();
    log("delivered", { id: reply.id, target: route.target, chat: route.chat, confirmed: receipt.confirmed });

    /** @type {import("./state.mjs").StateEntry} */
    const entry = {
      id: reply.id,
      itemId: reply.itemId,
      processedAt: at,
      delivery: { target: route.target, chat: route.chat, at, confirmed: receipt.confirmed, stages: receipt.stages },
      acked: false,
      shaped: true,
    };
    if (github) entry.github = github;
    state.put(entry);
    return (await ackEntry(entry)) ? "delivered" : "ack-failed";
  }

  /**
   * Types a late ask's question into the monitor chat, then tells the server whether it went; with no monitor chat set
   * it is not delivered. Each event id is typed once, so a resend after a lost ack is acked without typing it twice.
   * @param {unknown} raw
   * @returns {Promise<"dropped" | "delivered" | "failed">}
   */
  async function processLateAsk(raw) {
    const r = /** @type {any} */ (raw);
    const id = typeof r?.id === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(r.id) ? r.id : "?";
    const line = id === "?" ? null : lateAskLine(r);
    if (!line) {
      log("drop", { id, reason: "bad-late-ask" });
      return "dropped";
    }
    const key = `late-ask-${id}`;
    let delivered = state.get(key) !== undefined;
    if (delivered) log("duplicate", { id, kind: r.kind });
    else {
      delivered = await notifyMonitor(line);
      log(delivered ? "late-ask-delivered" : "late-ask-failed", { id, kind: r.kind });
      if (delivered) {
        const at = now().toISOString();
        state.put({ id: key, itemId: id, processedAt: at, delivery: { target: "rivet", chat: /** @type {string} */ (monitorChat), at, confirmed: true, stages: [] }, acked: true });
      }
    }
    try {
      const res = await fetchFn(`${origin}/api/bridge/late-ask-ack`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ id, delivered }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUTS.http),
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw new Error(`late ask ack http ${res.status}`);
    } catch (err) {
      log("ack-failed", { id, error: short(err) });
    }
    return delivered ? "delivered" : "failed";
  }

  /**
   * The snapshot reads only the newest comments: a PR the pick-up names is read again whole, as the merge guard reads
   * it, before its line is typed. Held when the read fails or runs past its deadline.
   * @param {string} repo @param {string} key
   */
  async function prHeld(repo, key) {
    const pr = Number(key.split("/").pop());
    if (!Number.isInteger(pr) || pr <= 0) return true;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline;
    try {
      /** @type {Promise<never>} */
      const late = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`hold read past ${TIMEOUTS.prHolds} ms`)), TIMEOUTS.prHolds);
      });
      return (await Promise.race([prHolds(repo, pr), late])).length > 0;
    } catch (err) {
      log("ops-pickup-hold-read-failed", { error: short(err) });
      return true;
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * Types the server's auto pick-up into the monitor chat, then tells the server whether it got there: a failed one takes
   * its status back and goes again on a later tick. Each id is typed once, so a resend after a lost ack is not typed
   * twice.
   * @param {unknown} raw
   * @param {number} [receivedAt]
   * @returns {Promise<"dropped" | "delivered" | "failed">}
   */
  async function processOpsPickup(raw, receivedAt = now().getTime()) {
    const r = /** @type {any} */ (raw);
    const id = typeof r?.id === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(r.id) ? r.id : "?";
    const line = id === "?" ? null : opsPickupLine(r.kind, r.key, r.repo);
    if (!line) {
      log("drop", { id, reason: "bad-ops-pickup" });
      return "dropped";
    }
    const key = `ops-pickup-${id}`;
    let delivered = state.get(key) !== undefined;
    if (delivered) log("duplicate", { id });
    else if (r.kind === "pr" && (await prHeld(r.repo, r.key))) log("ops-pickup-dropped", { id, reason: "hold" });
    else {
      let stale = false;
      const unless = () => (stale = now().getTime() - receivedAt > PICKUP_STALE_MS);
      delivered = await notifyMonitor(line, { unless });
      if (stale) log("ops-pickup-dropped", { id, reason: "stale" });
      else log(delivered ? "ops-pickup-delivered" : "ops-pickup-failed", { id, kind: r.kind, key: r.key });
      if (delivered) {
        const at = now().toISOString();
        state.put({ id: key, itemId: `${r.kind}/${r.key}`, processedAt: at, delivery: { target: "rivet", chat: /** @type {string} */ (monitorChat), at, confirmed: true, stages: [] }, acked: true, shaped: true });
      }
    }
    try {
      const res = await fetchFn(`${origin}/api/bridge/ops-pickup-ack`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ id, delivered }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUTS.http),
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw new Error(`ops pick-up ack http ${res.status}`);
    } catch (err) {
      log("ack-failed", { id, error: short(err) });
    }
    return delivered ? "delivered" : "failed";
  }

  /**
   * Types the owner's Reopen of an answered card into the card's chat when it is running, else the monitor chat, then
   * tells the server: the app says the chat is told only once a delivered ack lands. A failed send ends the connection,
   * and the next one offers it again; with nowhere to type it, it is acked undelivered. Each event id is typed once, so
   * a resend after a lost ack is only acked.
   * @param {unknown} raw
   * @returns {Promise<"dropped" | "duplicate" | "delivered" | "delivery-failed" | "ack-failed">}
   */
  async function processReopen(raw) {
    const r = /** @type {any} */ (raw);
    const id = typeof r?.id === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(r.id) ? r.id : "?";
    if (id === "?" || !reopenLine(r)) {
      log("drop", { id, reason: "bad-reopen" });
      return "dropped";
    }
    const key = `reopen-${id}`;
    const seen = state.get(key);
    let nowhere = false;
    /** @type {{ delivered: boolean, confirmed?: boolean, error?: string }} */
    let body;
    if (seen) {
      log("duplicate", { id });
      body = { delivered: true, confirmed: seen.delivery?.confirmed === true };
    } else {
      try {
        const found = routeOf(await listTerminals(), r.chat, r.repo);
        if (!found) {
          nowhere = true;
          throw new Error("neither the card's chat nor a monitor chat is running");
        }
        const receipt = await sendLine(found.handle, sanitizeLine(/** @type {string} */ (reopenLine(r, found.direct))));
        const at = now().toISOString();
        state.put({ id: key, itemId: r.itemId, processedAt: at, delivery: { target: found.direct ? "chat" : "rivet", chat: found.handle, at, confirmed: receipt.confirmed, stages: receipt.stages }, acked: false });
        log("reopen-delivered", { id, chat: found.handle, confirmed: receipt.confirmed });
        body = { delivered: true, confirmed: receipt.confirmed };
      } catch (err) {
        log("reopen-failed", { id, error: short(err) });
        body = { delivered: false, error: short(err, true) };
      }
    }
    try {
      const res = await fetchFn(`${origin}/api/bridge/reopen-ack`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ id, ...body }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUTS.http),
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw new Error(`reopen ack http ${res.status}`);
    } catch (err) {
      log("ack-failed", { id, error: short(err) });
      return "ack-failed";
    }
    if (!body.delivered) return nowhere ? "dropped" : "delivery-failed";
    const entry = state.get(key);
    if (entry && !entry.acked) state.put({ ...entry, acked: true });
    return seen ? "duplicate" : "delivered";
  }

  /**
   * The last chat line failed to deliver (its chat down, say). Until one
   * delivers, chat lines wait their turn: otherwise the replayed chat would jump and
   * discard the same card answer on every reconnect, and that answer can still
   * reach its chat another way.
   */
  let chatFailing = false;

  /**
   * One SSE connection. Events are processed strictly one at a time while the
   * stream keeps being read, so keep-alives still arrive during slow deliveries.
   * A queued app chat line may go ahead of queued card answers (see takeNext).
   * @param {AbortSignal} [stop]
   * @returns {Promise<{ status: "ended" | "idle" | "unauthorized" | "http" | "error" | "delivery-failed" | "ack-failed" | "stopped", connected: boolean, code?: number }>}
   */
  async function connectOnce(stop) {
    const ctrl = new AbortController();
    /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
    let reader = null;
    let closed = false;
    // The reader is cancelled as well as the fetch aborted: a pending read must end
    // even when the abort never reaches the body (the stream has outlived it).
    const close = () => {
      closed = true;
      ctrl.abort();
      reader?.cancel().catch(() => {});
    };
    stop?.addEventListener("abort", close, { once: true });
    let idle = false;
    /** @type {"delivery-failed" | "ack-failed" | null} */
    let failure = null;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        idle = true;
        close();
      }, idleMs);
    };
    /** @type {{ event: string, raw: unknown, at: number }[]} */
    const queue = [];
    let overtakes = 0;
    /**
     * First in first out, except that an app chat line goes ahead of queued card answers: a card answer holds the line
     * for a send and two gh calls, so a chat window would wait behind each one queued. Answers are safe to pass because
     * the server re-sends them on reconnect if a failure clears the queue. A chat never passes anything else (a pause
     * or send must keep its order and is never replayed), never passes another chat, and passes at most OVERTAKE_LIMIT
     * times in a row so card answers still move.
     */
    const takeNext = () => {
      const at = queue.findIndex((q) => q.event === "chat");
      if (at > 0 && !chatFailing && overtakes < OVERTAKE_LIMIT && queue.slice(0, at).every((q) => OVERTAKABLE.has(q.event))) {
        overtakes++;
        return queue.splice(at, 1)[0];
      }
      const next = /** @type {{ event: string, raw: unknown, at: number }} */ (queue.shift());
      if (next.event !== "chat") overtakes = 0;
      return next;
    };
    /** @type {Promise<void> | null} */
    let worker = null;
    const drain = async () => {
      // Yields first so `worker` is assigned before this clears it; a stale promise
      // left in `worker` spins finish() forever and freezes the whole bridge.
      await null;
      while (queue.length > 0 && !failure && !stop?.aborted) {
        const next = takeNext();
        if (next.event === "late-ask") {
          await processLateAsk(next.raw);
          continue;
        }
        if (next.event === "ops-pickup") {
          await processOpsPickup(next.raw, next.at);
          continue;
        }
        let result;
        try {
          const family = actions.get(next.event);
          if (family) result = await family.handle(next.event, next.raw, { deps, listTerminals, sendLine });
          else result = next.event === "reopen" ? await processReopen(next.raw) : await processReply(next.raw);
        } catch (err) {
          log("process-failed", { error: short(err) });
          result = "delivery-failed";
        }
        const failed = result === "delivery-failed" || result === "ack-failed";
        if (next.event === "chat") chatFailing = failed;
        if (failed) {
          failure = result;
          queue.length = 0;
          close();
        }
      }
      worker = null;
    };
    /** @param {string} event @param {unknown} raw */
    const enqueue = (event, raw) => {
      queue.push({ event, raw, at: now().getTime() });
      if (!worker) worker = drain();
    };

    /** @param {string} event @param {unknown} raw */
    const handleNow = (event, raw) => {
      const family = actions.get(event);
      if (!family) return;
      Promise.resolve()
        .then(() => family.handle(event, raw, { deps, listTerminals, sendLine }))
        .catch((err) => log("process-failed", { event, error: short(err) }));
    };

    const finish = async (/** @type {any} */ result, /** @type {Record<string, unknown>} */ fields = {}) => {
      clearTimeout(timer);
      while (worker) await worker;
      stop?.removeEventListener("abort", close);
      if (failure) result = { ...result, status: failure };
      else if (stop?.aborted) result = { ...result, status: "stopped" };
      if (result.connected) log("disconnected", { reason: result.status, ...fields });
      return result;
    };

    arm();
    let res;
    try {
      res = await fetchFn(`${origin}/api/bridge/events`, {
        headers: { ...auth, accept: "text/event-stream", "cache-control": "no-cache", "x-rivet-bridge-features": FEATURES },
        redirect: "error",
        signal: ctrl.signal,
      });
    } catch (err) {
      log("connect-failed", { error: idle ? "idle timeout" : short(err) });
      return finish({ status: idle ? "idle" : "error", connected: false });
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      log("unauthorized", { status: res.status });
      return finish({ status: "unauthorized", connected: false, code: res.status });
    }
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body || !type.startsWith("text/event-stream")) {
      await res.body?.cancel().catch(() => {});
      log("connect-http", { status: res.status });
      return finish({ status: "http", connected: false, code: res.status });
    }
    log("connected");
    arm();
    const parser = new SseParser();
    const decoder = new TextDecoder("utf-8");
    reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || closed) break;
        arm();
        for (const item of parser.push(decoder.decode(value, { stream: true }))) {
          if (item.type !== "event" || (!BUILT_IN_EVENTS.has(item.event) && !actions.has(item.event))) continue;
          let raw;
          try {
            raw = JSON.parse(item.data);
          } catch {
            log("drop", {
              id: item.id && /^[A-Za-z0-9._-]{1,100}$/.test(item.id) ? item.id : "?",
              reason: "bad-json",
            });
            continue;
          }
          if (UNQUEUED.has(item.event)) handleNow(item.event, raw);
          else enqueue(item.event, raw);
        }
      }
    } catch (err) {
      if (!closed) {
        close();
        return finish({ status: "error", connected: true }, { error: short(err) });
      }
    }
    return finish({ status: idle ? "idle" : "ended", connected: true });
  }

  /**
   * Sends the live agent chats to the server: metadata only, never output.
   * @returns {Promise<number>} how many workers were sent
   */
  async function pushWorkers() {
    // A throw leaves the server its last snapshot, which goes stale and says so, rather than hiding chats as gone.
    const snapshot = workerSnapshot(await listTerminals());
    if (workRepos) {
      await Promise.all(snapshot.workers.map(async (worker) => {
        const repo = await workRepos(worker).catch(() => undefined);
        if (repo) worker.workRepo = repo;
      }));
    }
    /** @param {unknown} body */
    const put = (body) =>
      fetchFn(`${origin}/api/bridge/workers`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUTS.http),
      });
    const res = await putSnapshot(put, snapshot, (body) => body.workers.some((worker) => worker.startedAt !== undefined || worker.workRepo !== undefined)
      ? { ...body, workers: body.workers.map(({ startedAt: _startedAt, workRepo: _workRepo, ...worker }) => worker) }
      : null);
    await res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) throw new UnauthorizedError(res.status);
    if (!res.ok) throw new Error(`workers http ${res.status}`);
    return snapshot.workers.length;
  }

  /**
   * One line to the monitor chat. False, logged, when no monitor chat is set or running, the line could not be sent, or
   * `unless` says no once the chat is found, just before the send.
   * @param {string} line
   * @param {{ unless?: () => boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  async function notifyMonitor(line, { unless } = {}) {
    if (!monitorChat) {
      log("notify-failed", { reason: "no-monitor-chat" });
      return false;
    }
    try {
      const handle = resolveChatTerminal(await listTerminals(), monitorChat).handle;
      if (!handle) {
        log("notify-failed", { reason: "monitor-chat-not-running" });
        return false;
      }
      if (unless?.()) return false;
      if (unless) {
        // The dialog can hold a line for minutes: what stops it is read again once it clears.
        await waitOutHold(handle);
        if (unless()) return false;
      }
      const receipt = await sendLine(handle, sanitizeLine(line));
      if (!receipt.confirmed) log("notify-unconfirmed", { stages: receipt.stages });
      return true;
    } catch (err) {
      log("notify-failed", { error: short(err) });
      return false;
    }
  }

  return { processReply, processLateAsk, processOpsPickup, processReopen, connectOnce, listTerminals, sendLine, ack, pushWorkers, notifyMonitor };
}

export class UnauthorizedError extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`http ${status}`);
    this.status = status;
  }
}

/**
 * Pushes the worker snapshot every WORKERS_INTERVAL_MS until stopped. Logs a
 * change in the count and each failure; 401/403 waits 5 minutes.
 * @param {Pick<ReturnType<typeof createBridge>, "pushWorkers">} bridge
 * @param {{ stop: AbortSignal, log: BridgeDeps["log"], sleep?: (ms: number, stop: AbortSignal) => Promise<void> }} opts
 */
export async function runWorkerFeed(bridge, { stop, log, sleep = abortableSleep }) {
  /** @type {number | null} */
  let last = null;
  while (!stop.aborted) {
    let delay = WORKERS_INTERVAL_MS;
    try {
      const count = await bridge.pushWorkers();
      if (count !== last) log("workers", { count });
      last = count;
    } catch (err) {
      last = null;
      if (err instanceof UnauthorizedError) {
        log("workers-unauthorized", { status: err.status });
        delay = UNAUTHORIZED_MS;
      } else {
        log("workers-failed", { error: short(err) });
      }
    }
    await sleep(delay, stop);
  }
}

/**
 * Reconnect loop: capped exponential backoff with jitter; 401/403 waits 5 minutes.
 * @param {ReturnType<typeof createBridge>} bridge
 * @param {{ stop: AbortSignal, log: BridgeDeps["log"], sleep?: (ms: number, stop: AbortSignal) => Promise<void>,
 *   random?: () => number, clock?: () => number }} opts
 */
export async function runLoop(bridge, { stop, log, sleep = abortableSleep, random = Math.random, clock = Date.now }) {
  let attempt = 0;
  while (!stop.aborted) {
    const started = clock();
    const r = await bridge.connectOnce(stop);
    if (stop.aborted || r.status === "stopped") break;
    let delay;
    if (r.status === "unauthorized") {
      delay = UNAUTHORIZED_MS;
      attempt = 0;
    } else {
      if (r.connected && r.status !== "delivery-failed" && r.status !== "ack-failed" && clock() - started >= 30_000) attempt = 0;
      delay = backoffDelay(attempt, random);
      attempt += 1;
    }
    log("reconnect-in", { ms: delay, after: r.status, attempt });
    await sleep(delay, stop);
  }
}

/** @param {number} ms @param {AbortSignal} stop */
function abortableSleep(ms, stop) {
  return new Promise((resolve) => {
    if (stop.aborted) return resolve(undefined);
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      stop.removeEventListener("abort", done);
      resolve(undefined);
    }
    stop.addEventListener("abort", done, { once: true });
  });
}
