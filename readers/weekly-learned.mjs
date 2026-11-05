#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serverError } from "../bridge/lib/board-client.mjs";
import { formatLog, makeExec, readToken, serverOrigin } from "../bridge/lib/config.mjs";
import { NO_RUN } from "../bridge/lib/scheduled-run.mjs";
import { zoneDay } from "../bridge/lib/spend.mjs";
import { HANDLER_LOG_FILE } from "../bridge/lib/rerun-guard.mjs";
import { READERS_DIR, makeRivetCli, oneLine, readJson, runReader, takeLock, writeJsonAtomic, writeTextAtomic } from "./lib.mjs";

// The weekly "what we learned" pass (launchd Sunday 7pm local time). It reads the week's fixed Ops records, groups them by
// what stops the fault coming back (the `prevent` line, else the `cause`), and puts at most three new auto-handlers on one
// decision card: Yes or Not now. It calls no model. The server keeps one record per failed item, so a line that comes back
// on the same item is only counted in a list of fixes the hourly `record` run keeps. A fix with no line is not proposed:
// the card says only what the records say, never a guess at what the fix was. A Yes is only written to the state file:
// nothing is built from the card. A Not now keeps the same proposal off for 30 days from the answer. A week with nothing to
// propose posts no card. A Sunday run that finds the lock held leaves a marker, and the next run (hourly) proposes in its
// place. With no RIVET_URL there is no server to read, and it does nothing.

export const JOB = "weekly-learned";
export const STATE_FILE = path.join(READERS_DIR, `${JOB}.json`);
export const DUE_FILE = `${STATE_FILE}.due`;
/** A marker older than this is a week that has gone by; the next Sunday covers it. */
export const DUE_HOURS = 72;
export const MAX_PROPOSALS = 3;
export const WINDOW_DAYS = 7;
export const REJECT_DAYS = 30;
/** A proposal nobody answered is left alone this long: its card is still on the feed, or just lapsed unseen. */
export const UNANSWERED_DAYS = 13;
const KEEP_DAYS = 60;
const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;
const YES = "Yes";
const NOT_NOW = "Not now";
const MAX_BULLET = 140;

/**
 * @typedef {{ id: string, kind: string, key: string, at: string, cause?: string, prevent?: string }} Fix
 * @typedef {{ key: string, card: string, text: string, count: number, kind: string, at: string, pending?: true, answer?: "yes" | "no", answeredAt?: string }} Proposal
 * @typedef {{ fixes: Fix[], proposed: Proposal[] }} State
 * @typedef {{ kind: string, key: string, state: string, by?: string, since: string, updatedAt: string, cause?: string, prevent?: string }} Status
 * @typedef {{ itemId: string, decision: string, choice?: string, rev?: string, at?: string }} Reply
 * @typedef {{ key: string, text: string, count: number, kind: string, last: string }} Group
 */

/** @returns {State} */
export const emptyState = () => ({ fixes: [], proposed: [] });

/** The words of a line without its PR numbers, which the card never shows. @param {string} text */
export function withoutPrNumbers(text) {
  return text.replace(/(?:\bPRs?\s*)?#\d+/gi, " ").replace(/\bPRs?\s+\d+/gi, " ").replace(/\s+/g, " ").trim();
}

/** Two lines about the same thing compare equal: case, punctuation and bare numbers do not count. @param {string} text */
function sameThing(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !/^\d+$/.test(word))
    .join(" ");
}

/** The later of when a proposal went up and when it was answered, in ms. @param {Proposal} p */
const lastTouched = (p) => Math.max(Date.parse(p.at), Date.parse(p.answeredAt ?? p.at));

/**
 * Adds every fixed record not in the list yet. A failure that comes back after a fix starts again with a new `since`,
 * so kind, key and `since` name one fix; a cause or prevent line written later is added to it.
 * @param {State} state @param {Status[]} statuses @param {Date} now
 */
export function recordFixes(state, statuses, now) {
  for (const status of statuses) {
    if (status.state !== "fixed") continue;
    const id = `${status.kind}/${status.key}@${status.since}`;
    const known = state.fixes.find((fix) => fix.id === id);
    const said = { ...(status.cause ? { cause: status.cause } : {}), ...(status.prevent ? { prevent: status.prevent } : {}) };
    if (known) Object.assign(known, said);
    else state.fixes.push({ id, kind: status.kind, key: status.key, at: status.updatedAt, ...said });
  }
  const cutoff = now.getTime() - KEEP_DAYS * DAY_MS;
  state.fixes = state.fixes.filter((fix) => Date.parse(fix.at) >= cutoff);
  state.proposed = state.proposed.filter((p) => lastTouched(p) >= cutoff);
}

/**
 * The fixes of the last week in groups, by their prevent line, else their cause. A line that is only a PR number says
 * nothing, so the next line counts. A fix with neither is in no group: naming it would be a guess at what fixed it.
 * @param {Fix[]} fixes @param {Date} now
 * @returns {Group[]} most fixes first, then the latest, then by key
 */
export function groupLearned(fixes, now) {
  const since = now.getTime() - WINDOW_DAYS * DAY_MS;
  const week = fixes.filter((fix) => Date.parse(fix.at) >= since);
  /** @type {Map<string, Group & { kinds: Map<string, number> }>} */
  const groups = new Map();
  for (const fix of week) {
    const text = [fix.prevent, fix.cause].map((line) => withoutPrNumbers(line ?? "")).find(sameThing);
    if (!text) continue;
    const key = `said:${sameThing(text)}`;
    const group = groups.get(key) ?? { key, text, count: 0, kind: fix.kind, last: fix.at, kinds: new Map() };
    group.count++;
    group.kinds.set(fix.kind, (group.kinds.get(fix.kind) ?? 0) + 1);
    if (fix.at >= group.last) {
      group.last = fix.at;
      group.text = text;
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ kinds, ...group }) => ({ ...group, kind: [...kinds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0] }))
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last) || a.key.localeCompare(b.key));
}

/** Whether a group may go on a card now: not answered in the last 30 days, not waiting on an answer. @param {State} state @param {string} key @param {Date} now */
export function mayPropose(state, key, now) {
  return !state.proposed.some((p) => {
    if (p.key !== key) return false;
    if (p.answer) return Date.parse(p.answeredAt ?? p.at) + REJECT_DAYS * DAY_MS > now.getTime();
    return Date.parse(p.at) + UNANSWERED_DAYS * DAY_MS > now.getTime();
  });
}

/** @param {Group[]} groups @param {State} state @param {Date} now */
export function chooseProposals(groups, state, now) {
  return groups.filter((group) => mayPropose(state, group.key, now)).slice(0, MAX_PROPOSALS);
}

/**
 * The answers to the cards this job posted. A card changed with Answer again has a new revision, and the newest
 * revision's first Yes or Not now is the answer of record, so a changed answer is recorded in either direction. A Yes is
 * marked accepted in the state file; nothing acts on it. Returns the proposals whose answer is new or changed.
 * @param {State} state @param {Reply[]} replies
 */
export function syncAnswers(state, replies) {
  const changed = [];
  for (const p of state.proposed) {
    const mine = replies
      .filter((r) => r.itemId === p.card && ((r.decision === "choice" && (r.choice === YES || r.choice === NOT_NOW)) || r.decision === "approve" || r.decision === "reject"))
      // Replies come newest first; reversed, a stable sort keeps two in one millisecond in the order they came.
      .reverse()
      .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
    const rev = mine.at(-1)?.rev;
    const first = mine.find((r) => r.rev === rev);
    if (!first) continue;
    const answer = first.decision === "approve" || first.choice === YES ? "yes" : "no";
    if (p.answer === answer) continue;
    p.answer = answer;
    p.answeredAt = first.at ?? new Date().toISOString();
    changed.push(p);
  }
  return changed;
}

/**
 * A card id is its Sunday plus a random suffix kept with the proposals, so nobody can create the card first and have its
 * answers read as ours; an "already exists" on the retry then can only be our own earlier create.
 * @param {Date} now @param {string} [nonce]
 */
export const cardId = (now, nonce) => `${JOB}-${zoneDay(now).replace(/-/g, "")}${nonce ? `-${nonce}` : ""}`;

/** The card: a heading and one short bullet for each proposal. @param {Pick<Group, "text" | "count">[]} groups @param {string} id */
export function renderCard(groups, id, lookBack = "") {
  const bullets = groups.map((g) => `- ${oneLine(`${g.text} (fixed ${g.count === 1 ? "once" : `${g.count} times`})`, MAX_BULLET)}`).join("\n");
  return {
    id,
    title: `Rivet's week: handle ${groups.length === 1 ? "this" : "these"} by itself?`,
    ask: lookBack ? `${bullets}\n\n${lookBack}` : bullets,
    options: [YES, NOT_NOW],
  };
}

/**
 * The week's automatic handlers in one line, "" when they did nothing. Only what was done counts: the plan-mode "would"
 * lines do not, and an unreadable line is skipped.
 * @param {string} text the handlers' log @param {Date} now
 */
export function lookBackLine(text, now) {
  let rerun = 0;
  let passed = 0;
  let red = 0;
  for (const line of text.split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const age = now.getTime() - Date.parse(entry?.at);
    if (!(age >= 0 && age < 7 * 24 * HOUR_MS)) continue;
    if (entry.handler === "main-rerun" || entry.handler === "pr-rerun") {
      if (entry.decision === "rerun") rerun++;
      else if (entry.decision === "passed") passed++;
      else if (entry.decision === "stayed-red") red++;
    }
  }
  return rerun ? `Re-ran ${rerun} ${rerun === 1 ? "check" : "checks"}, ${passed} passed, ${red} stayed red.` : "";
}

/** The server said the card is already there: an earlier create did land. @param {unknown} err */
const alreadyThere = (err) => /already exists/.test(String(/** @type {any} */ (err)?.stderrFirstLine ?? /** @type {any} */ (err)?.message ?? ""));

/**
 * One run. `record` keeps the list of fixes, reads answers and sends a card that did not go; `propose` does that too, then posts
 * the week's card when there is something to propose. Every read and write goes through `d`, so the tests swap them.
 * `week` is the Sunday this run proposes for: `now`, or the earlier time a marker kept, so a retry after midnight sends the
 * saved card and starts no second one.
 * @param {{ mode: "record" | "propose", now: Date, week?: Date, state: State, statuses: () => Promise<Status[]>,
 *   replies: (cards: string[]) => Promise<Reply[]>, addCard: (card: ReturnType<typeof renderCard>) => Promise<void>,
 *   save: (state: State) => void, nonce: () => string, handlerLog?: () => string, log: (event: string, fields?: Record<string, unknown>) => void }} d
 * @returns {Promise<State>}
 */
export async function runWeekly(d) {
  const state = structuredClone(d.state);
  recordFixes(state, await d.statuses(), d.now);
  d.save(state);

  // A card is created under its Sunday's id, so a create whose answer was lost is sent again as it was, and an
  // "already exists" answer means the first one landed. The proposals stay pending (and off the next card) until then.
  /** @param {string} id */
  const send = async (id) => {
    const mine = state.proposed.filter((p) => p.card === id && p.pending);
    if (!mine.length) return;
    const card = renderCard(mine, id, lookBackLine(d.handlerLog?.() ?? "", d.now));
    try {
      await d.addCard(card);
    } catch (err) {
      if (!alreadyThere(err)) {
        d.log("card-not-posted", { card: id, error: err instanceof Error ? err.message.slice(0, 200) : "error" });
        throw err;
      }
    }
    for (const p of mine) delete p.pending;
    d.save(state);
    d.log("posted", { card: id, count: mine.length });
  };
  for (const id of new Set(state.proposed.filter((p) => p.pending).map((p) => p.card))) {
    const age = d.now.getTime() - Math.min(...state.proposed.filter((p) => p.card === id).map((p) => Date.parse(p.at)));
    if (age > DUE_HOURS * HOUR_MS) {
      state.proposed = state.proposed.filter((p) => p.card !== id);
      d.log("card-lost", { card: id });
      continue;
    }
    try {
      await send(id);
    } catch (err) {
      if (d.mode === "propose") throw err;
    }
  }

  // Answers are read for a card while it waits and for 30 days after it was last touched, so a changed answer is seen.
  const watching = [...new Set(state.proposed.filter((p) => (!p.answer || lastTouched(p) + REJECT_DAYS * DAY_MS > d.now.getTime())).map((p) => p.card))];
  let read = true;
  if (watching.length) {
    try {
      for (const p of syncAnswers(state, await d.replies(watching))) d.log(p.answer === "yes" ? "accepted" : "declined", { card: p.card, proposal: p.text });
    } catch (err) {
      // Proposing without the answers could offer again what was just turned down.
      if (d.mode === "propose") throw err;
      read = false;
      d.log("answers-not-read", { error: err instanceof Error ? err.message.slice(0, 200) : "error" });
    }
  }
  d.save(state);
  if (d.mode !== "propose" || !read) return state;

  const week = d.week ?? d.now;
  if (state.proposed.some((p) => p.card.startsWith(cardId(week)))) {
    d.log("already-proposed", { card: cardId(week) });
    return state;
  }
  const chosen = chooseProposals(groupLearned(state.fixes, d.now), state, d.now);
  if (!chosen.length) {
    d.log("nothing-to-propose", { fixes: state.fixes.length });
    return state;
  }
  const id = cardId(week, d.nonce());
  state.proposed.push(...chosen.map((g) => ({ key: g.key, card: id, text: g.text, count: g.count, kind: g.kind, at: d.now.toISOString(), pending: /** @type {const} */ (true) })));
  d.save(state);
  await send(id);
  return state;
}

/**
 * One scheduled run under the lock. A `propose` run that finds the lock held leaves a marker, and the next run of
 * either kind that gets the lock proposes: no Sunday's card is lost to the hourly run holding the lock.
 * @param {{ mode: "record" | "propose", now: Date, lock: () => (() => void) | null, readDue: () => string | null,
 *   writeDue: (at: string) => void, clearDue: () => void, run: (mode: "record" | "propose", week: Date) => Promise<unknown>,
 *   log: (event: string, fields?: Record<string, unknown>) => void }} d
 */
export async function pass(d) {
  const release = d.lock();
  if (!release) {
    if (d.mode === "propose") d.writeDue(d.now.toISOString());
    d.log("pass", { stopped: "busy", ...(d.mode === "propose" ? { left: "the next run proposes" } : {}) });
    return NO_RUN;
  }
  try {
    const due = d.readDue();
    const owed = due !== null && d.now.getTime() - Date.parse(due) < DUE_HOURS * HOUR_MS;
    const mode = d.mode === "propose" || owed ? "propose" : "record";
    if (mode === "propose" && !owed) d.writeDue(d.now.toISOString());
    await d.run(mode, owed ? new Date(/** @type {string} */ (due)) : d.now);
    if (mode === "propose") d.clearDue();
  } finally {
    release();
  }
}

/**
 * The rivet CLI call that raises the reader's card: its title, ask and options go on stdin by `--args -`, never in the
 * command's arguments.
 * @param {{ id: string, title: string, ask: string, options: string[] }} card @param {string} [chat]
 */
export function cardAddCall(card, chat) {
  const flags = ["--kind", "decision", "--title", card.title, "--ask", card.ask, ...card.options.flatMap((o) => ["--option", o]), ...(chat ? ["--chat", chat] : [])];
  return { args: ["card", "add", card.id, "--args", "-"], input: JSON.stringify(flags) };
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "record" && mode !== "propose") throw new Error("usage: weekly-learned.mjs record|propose");
  const log = (/** @type {string} */ event, /** @type {Record<string, unknown> | undefined} */ fields) => console.log(formatLog(`${JOB}-${event}`, fields));
  if (!process.env.RIVET_URL) {
    log("pass", { stopped: "not-set-up" });
    return NO_RUN;
  }
  const exec = makeExec();
  const rivet = makeRivetCli(exec);
  return pass({
    mode,
    now: new Date(),
    lock: () => takeLock(JOB),
    readDue: () => {
      try {
        return fs.readFileSync(DUE_FILE, "utf8").trim() || null;
      } catch {
        return null;
      }
    },
    writeDue: (at) => writeTextAtomic(DUE_FILE, `${at}\n`),
    clearDue: () => fs.rmSync(DUE_FILE, { force: true }),
    log,
    run: async (runMode, week) => {
      const origin = serverOrigin(process.env.RIVET_URL);
      const token = await readToken(exec, "RIVET_BOARD_TOKEN");
      await runWeekly({
        mode: runMode,
        now: new Date(),
        week,
        state: { ...emptyState(), ...readJson(STATE_FILE, {}) },
        statuses: async () => JSON.parse(await rivet(["status", "list", "--json"])).statuses ?? [],
        replies: async (cards) => {
          const res = await fetch(`${origin}/api/replies?limit=500&${cards.map((c) => `item=${encodeURIComponent(c)}`).join("&")}`, {
            headers: { authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new Error(`GET /api/replies: ${await serverError(res)}`);
          return (await res.json()).replies ?? [];
        },
        addCard: async (card) => {
          const call = cardAddCall(card, process.env.RIVET_MONITOR_CHAT);
          await rivet(call.args, call.input);
        },
        save: (state) => writeJsonAtomic(STATE_FILE, state),
        nonce: () => randomBytes(6).toString("hex"),
        handlerLog: () => {
          try {
            return fs.readFileSync(HANDLER_LOG_FILE, "utf8");
          } catch {
            return "";
          }
        },
        log,
      });
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReader(JOB, main).then((code) => {
    process.exitCode = code;
  });
}
