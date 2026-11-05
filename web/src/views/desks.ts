import { chatName } from "../../../src/shared/names.js";
import "./desks.css";

import { askPrRepo, asksOfChat, newestAskOf, sameRepo, signalRepo, stageSignal, workerOfAsk, type StageReadings, type StageSignal } from "../../../src/shared/ask-stages.js";
import type { PullRequest } from "../../../src/shared/ops.js";
import type { Ask, AskStage } from "../../../src/shared/asks.js";
import { STAGE_LABELS, type ServedNeed } from "../../../src/shared/board.js";
import { fallbackTitle, shownTitle } from "../../../src/shared/short-titles.js";
import { isRepo } from "../../../src/shared/repos.js";
import { MERGE_MOVING_MS } from "../../../src/shared/summary.js";
import { when } from "../../../src/shared/when.js";
import type { Worker } from "../../../src/shared/workers.js";
import { homeOf, projectName } from "../backlog-logic.js";
import { STATE_WORDS } from "../crew-words.js";
import { isDesk } from "../desk.js";
import { IN_HAND, NEEDS_YOU, allMinimised, needYou, stageWord } from "../../../src/shared/words.js";
import { isGotIt } from "../../../src/shared/answers.js";
import { h, ICONS, svg } from "../dom.js";
import { opsData, watchOps } from "../ops-data.js";
import { MOOD_WORDS, rivet, type Mood } from "../rivet/rivet.js";
import { app, countedCards, crewLapsed, deck, isWorking, subscribe } from "../state.js";
import { openChatPeek, type PeekFacts } from "./chat-peek.js";
import { openBacklog } from "./backlog-sheet.js";
import { askingCards, cardsOf, openDecideFor } from "./decide-sheet.js";
import { deskLife, layoutBox, mapComing, mapSaid, mapStage } from "./desks-life.js";
import { clearWords } from "./progress-mark.js";
import { openRivetSummary } from "./rivet-summary.js";
import { closeTallSheet, leaveTallSheet, openTallSheet } from "./sheet.js";
import { askTime, bubbleOf, movingNow, openAsks, watchAsks } from "./your-asks.js";

/**
 * The desks: Rivet at his desk at the top, a desk spawned for each project with a chat at work, its sub-agents hovering
 * over it as little squares, what and when under each, as its ask row says.
 */

/** The desks on the floor at the last build, kept across mounts so going back to the tab does not spawn them again. */
let seen = new Set<string>();

/**
 * The chats at work: one agent each. One whose open ask names an open decision card by cardId sits here too, though
 * the server reads it idle: it marks waiting only the card's own chat, and the card may be on another.
 */
export const liveCrew = (): Worker[] => {
  if (crewLapsed()) return [];
  const open = new Set(askingCards().map((need) => need.id));
  const asks = openAsks();
  return (app.workers?.workers ?? []).filter((w) => isWorking(w) || (!w.rivet && (w.state === "waiting" || asksOfChat(w, asks).some((ask) => ask.cardId && open.has(ask.cardId)))));
};

/** The stage readings, with the PRs as Ops reads them: a row shows their titles and check times. */
type DeskReadings = Omit<StageReadings, "prs"> & { prs: readonly PullRequest[] };

/** The readings the map's rows go by: a merged PR counts for half an hour, until a deploy or a shipped event says it went out. */
function mapReadings(now: number): DeskReadings {
  const { queue, prs } = movingNow();
  const events = (opsData.timeline?.days ?? []).flatMap((day) => day.events);
  const out = events.filter((event) => event.kind === "deploy" || event.kind === "shipped");
  const merged = events.flatMap((event) => {
    if (event.kind !== "merged" || event.number === undefined || !event.at || !(now - Date.parse(event.at) < MERGE_MOVING_MS)) return [];
    if (out.some((one) => (one.number === event.number && sameRepo(one.repo, event.repo)) || (one.sha && event.mergeSha?.startsWith(one.sha)) || one.patchMerges?.some((sha) => event.mergeSha?.startsWith(sha) || (event.mergeSha && sha.startsWith(event.mergeSha))))) return [];
    return [{ repo: event.repo, number: event.number, ...(event.branch ? { branch: event.branch } : {}), at: event.at }];
  });
  return { queue, prs, merged };
}

/** Where a row's work is by the readings: with an ask, by the PRs it names; else by the ones its chat's board entry lists. */
function signalOf(w: Worker, ask: Ask | undefined, readings: DeskReadings): StageSignal | null {
  return stageSignal({ chat: w.chat, repos: ask ? [askPrRepo(ask, w), w.repo] : [w.repo], prs: ask?.prs ?? w.prs ?? [], ...(w.branch ? { branch: w.branch } : {}), ...(ask ? { since: ask.createdAt } : {}) }, readings);
}

/** Every repo this phone has read, each once in a steady order: the timeline's, then any a chat, an ask or a PR names. */
function knownRepos(): string[] {
  const chats = (app.workers?.workers ?? []).flatMap((w) => [w.project, w.repo]);
  const named = [...(opsData.timeline?.repos ?? []), ...chats, ...openAsks().map((ask) => ask.repo), ...movingNow().prs.map((pr) => pr.repo)];
  return [...new Set(named.filter(isRepo))].sort((a, b) => projectName(a).localeCompare(projectName(b)));
}

/** A repo's full name: a timeline event or a queue row can give it without the owner. */
const fullRepo = (repo: string): Worker["repo"] => knownRepos().find((one) => sameRepo(one, repo)) ?? repo;

/** A row with no terminal behind it, for what agentRow, crowd and homeOf read. */
function noTerminal(id: string, chat: string, repo: Worker["repo"], asks: readonly Ask[], extra: Partial<Worker>): Worker {
  const filed = asks.find((ask) => ask.chat === chat)?.repo;
  return { id, name: chat, repo, ...(filed && filed !== repo ? { project: filed } : {}), chat, state: "idle", lastOutputAt: null, ...extra };
}

/**
 * Everything under way, one row each: the chats at work, an idle chat with an open ask past queued, an open PR or a
 * queue entry, a queue entry whose chat has no terminal, the open PRs no row holds, and a PR just merged no row holds.
 * An ask whose chat has gone with no signal gets none.
 */
export const underWay = (): Worker[] => {
  const now = Date.now();
  const asks = openAsks();
  const readings = mapReadings(now);
  // A lapsed crew says nothing of its chats or the queue; the GitHub readings are their own.
  const all = crewLapsed() ? [] : (app.workers?.workers ?? []);
  const rows = liveCrew();
  const held = new Set(rows.map((w) => w.id));
  for (const w of all) {
    if (w.rivet || held.has(w.id)) continue;
    const ask = newestAskOf(w, asks);
    const signal = signalOf(w, ask, readings);
    if ((ask && ask.stage !== "queued") || (signal && signal.stage !== "deploying")) rows.push(w);
  }
  const monitor = all.find((w) => w.rivet)?.chat;
  for (const row of readings.queue) {
    const id = `queue:${row.repo}/${row.chat}`;
    if (row.chat === monitor || held.has(id) || all.some((w) => w.chat === row.chat && w.repo === row.repo)) continue;
    held.add(id);
    const open = row.pr ?? readings.prs.find((pr) => row.branch !== undefined && pr.branch === row.branch && sameRepo(pr.repo, row.repo))?.number;
    const title = readings.prs.find((pr) => pr.number === open && sameRepo(pr.repo, row.repo))?.title ?? chatName(row.chat);
    rows.push(noTerminal(id, row.chat, row.repo, asks, { ...(row.branch ? { branch: row.branch } : {}), ...(open ? { prs: [open], what: `#${open} ${title}` } : {}) }));
  }
  // PR numbers repeat across repos, so a row holds a PR by its repo too.
  const prKey = (repo: string, number: number) => `${fullRepo(repo)}#${number}`;
  // A row holds the PRs of the ask it reads, its chat's newest, bar a merge from before the ask (named for context):
  // an older ask's PRs and such a merge keep rows of their own.
  const claims = (ask: Ask, w = workerOfAsk(ask, all)) => {
    const repo = askPrRepo(ask, w);
    const before = (pr: number) => readings.merged.some((one) => one.number === pr && sameRepo(one.repo, repo) && Date.parse(one.at) < Date.parse(ask.createdAt));
    return ask.prs.filter((pr) => !before(pr)).map((pr) => prKey(repo, pr));
  };
  const taken = new Set(
    rows.flatMap((w) => {
      const ask = newestAskOf(w, asks);
      const signal = signalOf(w, ask, readings);
      return [
        // The board's PRs only when no ask is read, as signalOf joins them: else they can be an older ask's.
        ...(ask ? claims(ask, w) : (w.prs ?? []).map((pr) => prKey(w.repo, pr))),
        ...(signal?.pr !== undefined ? [prKey(signalRepo(signal) ?? w.repo, signal.pr)] : []),
      ];
    }),
  );
  const add = (id: string, number: number, repo: Worker["repo"], title: string, branch?: string, mergedAt?: string) => {
    if (taken.has(prKey(repo, number))) return;
    taken.add(prKey(repo, number));
    const named = asks.find((one) => one.chat && one.prs.includes(number) && sameRepo(askPrRepo(one, workerOfAsk(one, all)), repo));
    // A row reads its chat's newest ask, so it takes the chat's name only when that is the ask naming this PR, and not
    // for a merge from before the ask, which only names it for context.
    const newest = named?.chat !== undefined && newestAskOf({ chat: named.chat, repo: named.repo ?? repo }, asks)?.id === named.id;
    const ask = newest && !(mergedAt && Date.parse(mergedAt) < Date.parse(named.createdAt)) ? named : undefined;
    for (const key of ask ? claims(ask) : []) taken.add(key);
    rows.push(noTerminal(id, ask?.chat ?? `pr-${number}`, repo, asks, { ...(branch ? { branch } : {}), prs: [number], what: `#${number} ${title}` }));
  };
  for (const pr of readings.prs) if (!pr.draft) add(`pr:${pr.repo}#${pr.number}`, pr.number, fullRepo(pr.repo), pr.title, pr.branch);
  for (const event of (opsData.timeline?.days ?? []).flatMap((day) => day.events)) {
    const merged = readings.merged.find((one) => event.kind === "merged" && one.number === event.number && sameRepo(one.repo, event.repo));
    if (merged) add(`merged:${fullRepo(merged.repo)}#${merged.number}`, merged.number, fullRepo(merged.repo), event.title.replace(/\s*\(#\d+\)\s*$/, ""), merged.branch, merged.at);
  }
  return rows;
};

/** Asking while cards wait on you, working while any agent is live, else the word for Ops. */
export function rivetMood(): Mood {
  // A Got it card is news, so it never makes him asking, as it never counts as needing him (state.needsYou).
  if (countedCards().some((need) => !isGotIt(need))) return "asking";
  return liveCrew().length ? "working" : clearWords().mood;
}

/**
 * A live agent needs you while it holds an open decision card: the room's "N needs you", its ? and its Needs you all
 * read this, so they always agree. One waiting with none reads as waiting and counts as neither.
 */
const asking = (w: Worker, crew: readonly Worker[], cards: readonly ServedNeed[], asks: readonly Ask[]) => cardsOf(w, crew, cards, asks).length > 0;

/** A crowded map (this many rows or more) goes to one line a row under stage headings, at most `MAP_ROWS`, its last row "N more ›" for the rest. */
const CROWDED = 15;
const MAP_ROWS = 40;

/** The stages in pipeline order, as a box's pills and a crowded box's headings read. */
const PIPELINE = ["needs-you", "deploying", "merging", "review", "push-queue", "building"] as const satisfies readonly AskStage[];
type RowStage = (typeof PIPELINE)[number];

/**
 * The agents the map seats and those it leaves for the "N more ›" sheet: on a crowded map those holding an open card
 * go first (their row is how you reach the card), then the building ones, then the rest; both keep the crew's order.
 * The map never seats more than `MAP_ROWS`: holders past it wait in the sheet, whose rows open their cards too.
 */
export function crowd(crew: readonly Worker[], cards: readonly ServedNeed[], asks: readonly Ask[]): { seated: Worker[]; rest: Worker[] } {
  if (crew.length < CROWDED) return { seated: [...crew], rest: [] };
  const holds = new Set(crew.filter((w) => asking(w, crew, cards, asks)));
  const rank = (w: Worker) => (holds.has(w) ? 0 : isWorking(w) ? 1 : 2);
  const kept = new Set(
    crew
      .map((w, i) => ({ w, i }))
      .sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
      .slice(0, MAP_ROWS)
      .map(({ w }) => w),
  );
  return { seated: crew.filter((w) => kept.has(w)), rest: crew.filter((w) => !kept.has(w)) };
}

/**
 * An agent's row title: its ask's short title, else its own from what it is at, else its chat's name. A row never shows
 * a long ask or status line: before a short title is written, it reads the words' trimmed first clause. Your own words
 * are in In hand.
 */
export function rowTitle(w: Worker, ask?: Ask): string {
  if (ask) return shownTitle(ask.short, ask.words);
  const what = w.what ?? w.doing;
  return what ? shownTitle(w.short, what) : fallbackTitle(chatName(w.chat));
}

/** A waiting agent with no decision card: STATE_WORDS says Needs you for waiting, which only a card may say here. */
const WAITING = "Waiting";

/** The chat's newest open ask, the row its status line reads. */
export function askOf(w: Worker, asks: readonly Ask[]): Ask | undefined {
  return newestAskOf(w, asks);
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/**
 * A row's stage and time. The stage: Needs you while it holds a card; else its ask's; else the readings'; else Building.
 * The time: its place in the queue with any promise after it; tests red on a failing PR in review; else its ask's time,
 * or since its signal (merged, CI started, the head's push).
 */
function rowView(w: Worker, asks: readonly Ask[], now: number, holds: boolean, readings: DeskReadings): { stage: RowStage; time: { text: string; tone: string | null } | null; signal: StageSignal | null } {
  const ask = askOf(w, asks);
  const signal = signalOf(w, ask, readings);
  const shown = holds ? "needs-you" : (mapStage(ask, holds) ?? signal?.stage ?? "building");
  const stage = (PIPELINE as readonly string[]).includes(shown) ? (shown as RowStage) : "building";
  const promised = ask ? askTime(ask, now) : null;
  const open = signal?.open;
  const pr = open && readings.prs.find((one) => one.number === open.number && sameRepo(one.repo, open.repo));
  if (shown === "push-queue" && signal?.entry) {
    const place = ordinal(signal.entry.position);
    return { stage, time: { text: promised ? `${place} · ${promised.text}` : place, tone: promised?.tone ?? null }, signal };
  }
  if (shown === "review" && pr?.checks.state === "fail") return { stage, time: { text: `tests red ${when(pr.ciStartedAt ?? pr.headAt ?? pr.updatedAt, now)}`, tone: "asked" }, signal };
  if (promised) return { stage, time: promised, signal };
  const since = shown === "needs-you" || shown === "queued" ? undefined : (signal?.merged?.at ?? pr?.ciStartedAt ?? pr?.headAt);
  return { stage, time: since ? { text: `since ${when(since, now)}`, tone: null } : null, signal };
}

/**
 * An agent's status line: Needs you while it holds an open decision card (`holds`), so its ? and its words agree; else
 * its ask row's time in short, so the map and the rows never say two things; else its stage, or its
 * state's word (Waiting). No Ask for a time.
 */
export function deskBubble(w: Worker, asks: readonly Ask[], now = Date.now(), holds = false, readings: DeskReadings = { queue: [], prs: [], merged: [] }): { text: string; tone: string | null } {
  if (holds) return { text: NEEDS_YOU, tone: "needs" };
  const ask = askOf(w, asks);
  const { time, signal } = rowView(w, asks, now, holds, readings);
  const stage = mapStage(ask, holds);
  const word = stage ? stageWord(stage) : signal ? IN_HAND[signal.stage] : null;
  if (word) return { text: time ? `${word} · ${time.text}` : word, tone: time?.tone ?? null };
  const coming = mapComing(w, holds);
  return { text: mapSaid(w, holds) ?? (coming ? STAGE_LABELS[coming] : w.state === "waiting" ? WAITING : STATE_WORDS[w.state]), tone: null };
}

/** What the chat sheet shows of a row, as the map reads it now; null once the row has left the map. */
export function peekFacts(id: string): PeekFacts | null {
  const crew = underWay();
  const w = crew.find((one) => one.id === id);
  if (!w) return null;
  const asks = openAsks();
  const now = Date.now();
  const ask = askOf(w, asks);
  const view = rowView(w, asks, now, asking(w, crew, askingCards(), asks), mapReadings(now));
  const signalPr = view.signal?.pr;
  return {
    worker: w,
    title: rowTitle(w, ask),
    project: projectName(homeOf(w)),
    ...(ask ? { ask } : {}),
    stage: view.stage === "needs-you" ? NEEDS_YOU : IN_HAND[view.stage],
    time: view.time,
    prs: [
      ...(ask?.prs ?? w.prs ?? []).map((number) => ({ number, repo: ask ? askPrRepo(ask, w) : w.repo })),
      ...(signalPr === undefined || !view.signal ? [] : [{ number: signalPr, repo: fullRepo(signalRepo(view.signal) ?? w.repo) }]),
    ].filter((pr, i, all) => all.findIndex((one) => one.number === pr.number && one.repo === pr.repo) === i),
  };
}

/**
 * What and when under an agent: its ask's words and its row's time, with Building's share as a bar. An agent holding an
 * open card wears a gold ? (a mark, never a count) and the whole row opens its Decide sheet; one whose ask is past its
 * time (its row's No time yet) wears a red ring. Any other row opens its chat sheet: what it is doing, what it last
 * said and its screen.
 */
function agentRow(w: Worker, i: number, asks: readonly Ask[], now: number, crew: readonly Worker[], cards: readonly ServedNeed[], readings: DeskReadings, oneLine = false): HTMLElement {
  const holds = asking(w, crew, cards, asks);
  const mood: Mood = holds ? "asking" : "working";
  const bot = rivet(mood, { tone: "agent", size: oneLine ? 28 : isDesk() ? 48 : 36, glow: true });
  bot.style.setProperty("--rv-delay", `${-(i * 0.47) % 2.6}s`);
  const ask = askOf(w, asks);
  const view = rowView(w, asks, now, holds, readings);
  const needs = view.stage === "needs-you";
  // One line: its stage is the heading over it, so only its time; Needs you has no heading and says so itself.
  const said = oneLine && !needs ? { text: view.time?.text ?? "", tone: view.time?.tone ?? null } : oneLine ? { text: `${NEEDS_YOU} ›`, tone: "needs" } : deskBubble(w, asks, now, holds, readings);
  // Its words say Needs you while it holds a card; its ring still reads its ask's lateness.
  const late = ask ? bubbleOf(ask, now).tone === "asked" : false;
  if (holds && !oneLine) bot.append(h("span", { class: "desk-agent-ask", attrs: { "aria-hidden": "true" } }, "?"));
  const progress = oneLine ? undefined : ask ? (ask.stage === "building" ? ask.progress : undefined) : w.progress;
  const fill = progress !== undefined ? h("span", { class: "desk-agent-fill" }) : null;
  // The page's CSP takes no style attribute, so the fill is sized through the CSSOM.
  if (fill && progress !== undefined) fill.style.width = `${Math.round(progress * 100)}%`;
  return h(
    "div",
    { class: `desk-agent${oneLine ? " is-line" : ""}${mood === "asking" ? " is-asking" : ""}${holds ? " has-card" : " has-chat"}${late ? " is-late" : ""}`, attrs: { "data-agent": w.id } },
    bot,
    h(
      "div",
      { class: "desk-agent-tip" },
      h(
        "span",
        { class: "desk-agent-what" },
        rowTitle(w, ask),
        w.boxGuess ? h("span", { class: "desk-agent-guess", attrs: { role: "img", "aria-label": "Its project is a guess", title: "Its project is a guess" } }, "?") : null,
      ),
      h("span", { class: `desk-agent-meta${said.tone && said.tone !== "due" ? ` is-${said.tone}` : ""}` }, said.text),
      fill ? h("span", { class: "desk-agent-bar" }, fill) : null,
    ),
    holds
      ? h("button", {
          class: "desk-agent-tap",
          attrs: { type: "button", "data-use": "desks.worker.open-card", "aria-label": `${chatName(w.chat)}: ${NEEDS_YOU.toLowerCase()}. Open its card` },
          // The row stays while a poll changes nothing on it: read the agent as it is now. From the "N more" sheet, the
          // Decide sheet opens once that sheet's Back has landed.
          on: { click: () => leaveTallSheet(() => openDecideFor(underWay().find((one) => one.id === w.id) ?? w, underWay(), openAsks())) },
        })
      : h("button", {
          class: "desk-agent-tap",
          attrs: { type: "button", "data-use": "desks.worker.open-chat", "aria-label": `${chatName(w.chat)}: ${rowTitle(w, ask)}. Open its chat` },
          // From the "N more" sheet, the chat sheet opens once that sheet's Back has landed.
          on: { click: () => leaveTallSheet(() => openChatPeek(underWay().find((one) => one.id === w.id) ?? w, () => peekFacts(w.id))) },
        }),
  );
}

/** The rows a crowded map leaves off, under their projects, as the map would seat them; it follows the crew while open. */
function openRest(): void {
  const title = h("h2", { class: "floor-sheet-title" });
  const body = h("div", { class: "floor-sheet-body desks-rest" });
  let stop = () => {};
  const paint = () => {
    const crew = underWay();
    const asks = openAsks();
    const cards = askingCards();
    const { rest } = crowd(crew, cards, asks);
    if (!rest.length) return closeTallSheet();
    const now = Date.now();
    const readings = mapReadings(now);
    title.textContent = `${rest.length} more under way`;
    const groups = [...new Set(rest.map(homeOf))].sort((a, b) => projectName(a).localeCompare(projectName(b))).map((place) =>
      h(
        "section",
        { class: "desks-rest-group", attrs: { "data-desk": place } },
        h("h3", { class: "desk-name" }, projectName(place)),
        h("div", { class: "desk-agents" }, ...rest.filter((w) => homeOf(w) === place).map((w, i) => agentRow(w, i, asks, now, crew, cards, readings))),
      ),
    );
    if (groups.map((one) => one.outerHTML).join("") !== [...body.children].map((one) => one.outerHTML).join("")) body.replaceChildren(...groups);
  };
  const close = h("button", { class: "decide-close", attrs: { type: "button", "aria-label": "Close", "data-use": "desks.rest.close" }, on: { click: () => closeTallSheet() } }, svg(ICONS.back, "btn-icon"));
  openTallSheet(
    "More under way",
    {
      mount(el) {
        el.replaceChildren(h("header", { class: "floor-sheet-head" }, title, close), body);
        const unsubscribe = subscribe(paint);
        const unwatchAsks = watchAsks(paint);
        stop = () => {
          unsubscribe();
          unwatchAsks();
        };
        paint();
      },
      unmount: () => stop(),
    },
    { className: "floor-sheet desks-rest-sheet", use: "desks.rest" },
  );
}

export function mountDesks(): { el: HTMLElement; paint: () => void; stop: () => void } {
  const el = h("div", { class: "desks" });
  const lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  lines.setAttribute("class", "desks-lines");
  lines.setAttribute("aria-hidden", "true");
  let shown = "";
  const life = deskLife(el, liveCrew, (w) => askOf(w, openAsks()), () => opsData.timeline);

  // A paint that lands after stop leaves the map alone: a rebuild would restart the life's timers on a floor no longer shown.
  let stopped = false;
  function build(): void {
    if (stopped) return;
    const crew = underWay();
    const asks = openAsks();
    const cards = askingCards();
    const now = Date.now();
    const readings = mapReadings(now);
    const crowded = crew.length >= CROWDED;
    const byDesk = new Map<string, Worker[]>();
    for (const w of crew) {
      const at = homeOf(w);
      byDesk.set(at, [...(byDesk.get(at) ?? []), w]);
    }
    const { seated, rest } = crowd(crew, cards, asks);
    // A desk whose agents are all in the "N more" sheet is not drawn; its pills still count its whole team.
    const projects = knownRepos();
    const busy = [...byDesk.keys()].filter((place) => seated.some((w) => byDesk.get(place)?.includes(w))).sort((a, b) => projectName(a).localeCompare(projectName(b)));
    const mood = rivetMood();
    // His happy face here is All clear with nothing left for you, never Shipped. With only minimised cards waiting it
    // says they wait, as Cards' heading does, and never Needs you: a minimised card is out of the red counts. The deck
    // less the counted cards is the minimised ones, with or without a summary read.
    const small = deck().length - countedCards().length;
    const word = mood === "happy" ? (small ? allMinimised(small) : MOOD_WORDS.clear) : MOOD_WORDS[mood];
    // A tap on Rivet opens his sheet: Copy summary and his chat.
    const home = h(
      "button",
      { class: "desk is-rivet", attrs: { type: "button", "data-use": "desks.rivet", "data-mood": mood, "aria-label": `Rivet, ${word}` }, on: { click: openRivetSummary } },
      rivet(mood, { size: crowded ? (isDesk() ? 80 : 47) : isDesk() ? 128 : 76, glow: true }),
      h("div", { class: "desk-slab" }, h("span", { class: "desk-screen" }, h("i"), h("i"), h("i"))),
      h("span", { class: "desk-name" }, "Rivet's desk", h("span", { class: `desk-mood is-${mood}` }, word)),
    );
    const desks = busy.map((place) => {
      const team = byDesk.get(place) ?? [];
      const stageOf = (w: Worker) => rowView(w, asks, now, asking(w, crew, cards, asks), readings);
      // A chat waiting with no card, signal or ask the map reads (mapStage) reads as waiting and counts in no pill.
      const counted = team.filter((w) => !(w.state === "waiting" && !mapStage(askOf(w, asks), false) && !stageOf(w).signal && !asking(w, crew, cards, asks)));
      const pills = PIPELINE.map((stage) => ({ stage, count: counted.filter((w) => stageOf(w).stage === stage).length })).filter((one) => one.count);
      const here = team.filter((w) => seated.includes(w));
      const rows = crowded
        ? PIPELINE.flatMap((stage) => {
            const place = (w: Worker) => stageOf(w).signal?.entry?.position ?? Number.MAX_SAFE_INTEGER;
            const group = here.filter((w) => stageOf(w).stage === stage).sort((a, b) => (stage === "push-queue" ? place(a) - place(b) : 0));
            if (!group.length) return [];
            const row = group.map((w, i) => agentRow(w, i, asks, now, crew, cards, readings, true));
            return stage === "needs-you" ? row : [h("div", { class: "desk-stage" }, IN_HAND[stage]), ...row];
          })
        : here.map((w, i) => agentRow(w, i, asks, now, crew, cards, readings));
      return h(
        "div",
        { class: "desk is-project", attrs: { "data-desk": place } },
        h(
          "div",
          { class: "desk-head" },
          h("span", { class: "desk-name" }, projectName(place)),
          h(
            "span",
            { class: "desk-counts" },
            ...pills.map(({ stage, count }) => (stage === "needs-you" ? h("span", { class: "pill desk-count is-asking" }, needYou(count)) : h("span", { class: "pill desk-count" }, `${count} ${IN_HAND[stage].toLowerCase()}`))),
          ),
        ),
        h("div", { class: "desk-agents" }, ...rows),
        h("div", { class: "desk-slab" }, h("span", { class: "desk-screen" }, h("i"), h("i"), h("i"))),
      );
    });
    const floor = [
      h("div", { class: "desks-home" }, home),
      ...(desks.length ? [h("div", { class: "desks-grid" }, ...desks)] : []),
      ...(rest.length ? [h("button", { class: "desks-more", attrs: { type: "button", "data-use": "desks.more" }, on: { click: openRest } }, `${rest.length} more ›`)] : []),
      // Every project's name under the boxes, the quiet ones dimmed. A tap opens its backlog.
      ...(projects.length
        ? [
            h(
              "div",
              { class: "desks-idle", attrs: { "aria-label": "Projects" } },
              ...projects.map((place) =>
                h(
                  "button",
                  { class: `desk-slot${busy.includes(place) ? "" : " is-quiet"}`, attrs: { type: "button", "data-use": "desks.project", "data-place": place, "aria-label": `${projectName(place)}: open its backlog` }, on: { click: () => openBacklog(place) } },
                  projectName(place),
                ),
              ),
            ),
          ]
        : []),
    ];
    // A poll that changes nothing leaves the floor alone, so the squares' hover and a spawn in flight carry on. The
    // bubbles read each ask's stage, which the floor need not show (two stages can share a time), so it counts too.
    const said = crew.map((w) => `${askOf(w, asks)?.stage ?? ""}:${rowView(w, asks, now, asking(w, crew, cards, asks), readings).time?.text ?? ""}`).join(",");
    const next = `${isDesk()}|${said}|${floor.map((part) => part.outerHTML).join("")}`;
    if (next === shown) return life.update();
    shown = next;
    let fresh = 0;
    desks.forEach((desk, i) => {
      if (seen.has(busy[i]!)) return;
      desk.classList.add("is-spawn");
      desk.style.setProperty("--spawn-delay", `${0.25 + fresh++ * 0.35}s`);
    });
    seen = new Set(busy);
    el.classList.toggle("is-empty", !desks.length);
    el.classList.toggle("is-crowded", crowded);
    // A rebuild keeps the row where you scrolled it.
    const rowLeft = el.querySelector<HTMLElement>(".desks-grid")?.scrollLeft ?? 0;
    el.replaceChildren(lines, ...floor, life.layer);
    const row = el.querySelector<HTMLElement>(".desks-grid");
    if (row) row.scrollLeft = rowLeft;
    requestAnimationFrame(drawLines);
    life.reset();
  }

  /** Where `node` sits in the floor's own scrolled content, by layout: a desk mid-spawn is measured where it lands. */
  const at = (node: HTMLElement) => layoutBox(el, node);

  /** A dashed line from Rivet's desk to each desk he spawned. */
  function drawLines(): void {
    const slab = el.querySelector<HTMLElement>(".desk.is-rivet .desk-slab");
    if (!slab || !el.clientWidth) return;
    // Measured without the old lines, so a shorter floor scrolls no further than its own end.
    lines.setAttribute("width", "0");
    lines.setAttribute("height", "0");
    lines.setAttribute("width", String(el.scrollWidth));
    lines.setAttribute("height", String(el.scrollHeight));
    const from = at(slab);
    const x0 = from.x + from.w / 2;
    const y0 = from.y + from.h;
    lines.innerHTML = [...el.querySelectorAll<HTMLElement>(".desk.is-project")]
      .map((desk) => {
        const to = at(desk);
        // It lands on the part of the box showing; a box wholly off the side gets a line running off that side.
        const lo = Math.max(to.x + 16, 24);
        const hi = Math.min(to.x + to.w - 16, el.clientWidth - 24);
        const middle = to.x + to.w / 2;
        const x1 = lo <= hi ? Math.min(hi, Math.max(lo, middle)) : middle;
        const y1 = to.y;
        const mid = (y0 + y1) / 2;
        return `<path d="M${x0} ${y0} C${x0} ${mid} ${x1} ${mid} ${x1} ${y1}"/>`;
      })
      .join("");
  }

  // The row side-scrolls: the lines follow it each frame, and bubbles and trips start again from where the boxes landed.
  let frame = 0;
  let settle = 0;
  const rowScrolled = (event: Event) => {
    if (!(event.target instanceof HTMLElement) || !event.target.classList.contains("desks-grid")) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(drawLines);
    window.clearTimeout(settle);
    life.layer.replaceChildren();
    settle = window.setTimeout(() => life.reset(), 250);
  };
  el.addEventListener("scroll", rowScrolled, { capture: true, passive: true });

  build();
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => drawLines()) : null;
  resize?.observe(el);
  const unsubscribe = subscribe(build);
  // Rivet's mood follows the Ops mark, which an Ops reading changes without the board; the status lines follow the asks.
  const unwatchOps = watchOps(build);
  const unwatchAsks = watchAsks(build);
  return {
    el,
    paint: build,
    stop: () => {
      stopped = true;
      window.clearTimeout(settle);
      cancelAnimationFrame(frame);
      unsubscribe();
      unwatchOps();
      unwatchAsks();
      resize?.disconnect();
      life.stop();
    },
  };
}
