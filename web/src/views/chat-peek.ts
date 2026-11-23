import "./chat-peek.css";

import type { AnsweredCard } from "../../../src/shared/answered.js";
import { askPrRepo, asksOfChat, type StageReadings } from "../../../src/shared/ask-stages.js";
import type { Ask } from "../../../src/shared/asks.js";
import type { LogsResponse } from "../../../src/shared/command.js";
import { chatName } from "../../../src/shared/names.js";
import type { OpsStatus } from "../../../src/shared/ops-status.js";
import type { ScreenItem } from "../../../src/shared/screen-view.js";
import { when } from "../../../src/shared/when.js";
import type { Worker } from "../../../src/shared/workers.js";
import * as api from "../api.js";
import { h, ICONS, svg } from "../dom.js";
import { rivet } from "../rivet/rivet.js";
import { mediaName } from "./card-media.js";
import { fetchDocument } from "./documents.js";
import { opsData, watchStatuses } from "../ops-data.js";
import { app, changed, crewLapsed, macOffline, subscribe } from "../state.js";
import { showLine } from "./chat.js";
import {
  activityRows,
  askedBy,
  askSourceLink,
  linkedPrs,
  mergedCards,
  opsRecordOf,
  ticketCards,
  ticketMeta,
  ticketPictures,
  ticketSolution,
  WHO_CHIPS,
  WHO_EMPTY,
  type ActivityRow,
} from "./chat-ticket.js";
import { askLine } from "./due-line.js";
import { holdFoot } from "./hold-foot.js";
import { openImages } from "./lightbox.js";
import { leaveOverlays } from "./navigation.js";
import { openRecord } from "./ops-plan.js";
import { STATE_LABEL } from "./ops-status.js";
import { prHref } from "./queue-cards.js";
import { closeTallSheet, openTallSheet } from "./sheet.js";
import { liveLog } from "./worker-sheet.js";
import { askTime, watchAsks } from "./your-asks.js";

/**
 * The map's chat sheet: a tap on a row with no card shows its chat as a ticket. A slim strip (stage, PR, time) over
 * three tabs: Ticket (the ask, what is being built, the pictures on its cards), Activity (who did what, filtered by who)
 * and Screen. Its screen is the live log the worker sheet reads (a lease, a 2s poll, the lines masked on the Mac and
 * again by the server), set out by screenView to read on a phone.
 */

export interface PeekFacts {
  worker: Worker;
  title: string;
  project: string;
  ask?: Ask;
  /** Every open ask the row is about, newest first (linkedAsks): `ask` is the one its strip and Activity read. */
  asks: Ask[];
  /** The chats at work and the PRs just merged, as the row was read: an ask's repo and which of its PRs link it. */
  chats?: readonly Worker[];
  merged?: StageReadings["merged"];
  stage: string;
  /** The row's stage key (`review`, `needs-you`…): the colour of the strip's dot. */
  stageKey?: string;
  time: { text: string; tone: string | null } | null;
  /** Each PR with the repo its number is in: an ask's and the signal's can differ. */
  prs: { number: number; repo: string }[];
}

export type PeekTab = "ticket" | "activity" | "screen";
const TABS: readonly { key: PeekTab; label: string }[] = [
  { key: "ticket", label: "Ticket" },
  { key: "activity", label: "Activity" },
  { key: "screen", label: "Screen" },
];

/** How long a read of the answered cards serves before the next paint reads them again. */
const ANSWERED_EVERY_MS = 30_000;
/** How soon a read of them that failed is tried again, with the sheet still open. */
const ANSWERED_RETRY_MS = 10_000;

/** One screen item as the box shows it. */
function itemView(item: ScreenItem): HTMLElement {
  switch (item.kind) {
    case "said":
      return h("p", { class: "peek-said" }, item.text);
    case "asked":
      return h("p", { class: "peek-asked" }, h("span", { class: "peek-label" }, "Typed in"), item.text);
    case "message":
      return h(
        "p",
        { class: "peek-message", attrs: { "data-way": item.way } },
        h("span", { class: "peek-label" }, item.way === "in" ? `From ${chatName(item.who)}` : `To ${chatName(item.who)}`),
        item.text,
      );
    case "working":
      return h("p", { class: "peek-working" }, h("span", { class: "peek-dot", attrs: { "aria-hidden": "true" } }), item.text);
    case "tool":
      return h(
        "div",
        { class: "peek-tool" },
        h("p", { class: "peek-call" }, h("span", { class: "peek-tool-name" }, item.name), item.detail ? h("code", { class: "peek-tool-detail" }, item.detail) : null),
        item.result.length
          ? h("ul", { class: "peek-result" }, ...item.result.map((line) => h("li", line.tone ? { attrs: { "data-tone": line.tone } } : {}, line.text)))
          : null,
      );
  }
}

/** Why a row's screen is not shown, or null when its chat is open on the Mac. */
export function screenGone(w: Worker, openChat: boolean): string | null {
  if (macOffline() || crewLapsed()) return "The Mac is offline. Its screen shows when the Mac is back.";
  if (openChat) return null;
  // Rows the map builds from GitHub or the push queue have an id of their own; a chat's row has its chat's.
  return w.id.includes(":") ? "This row has no chat open on the Mac: it's a PR, so there is no screen to show." : "This chat has closed. Nothing of its screen is kept.";
}

/**
 * The strip's time: the row's own, with the ask's promise said as a due time (`Due 10:36am`) where the map's short form
 * has `now 10:36am` or `by 10:36am`; a queue place or red tests before it stay as they are.
 */
export function dueText(facts: Pick<PeekFacts, "ask" | "time">, now = Date.now()): string {
  const text = facts.time?.text ?? "";
  const ask = facts.ask;
  const promise = ask?.dueAt && Date.parse(ask.dueAt) > now ? askTime(ask, now)?.text : undefined;
  if (!ask?.dueAt || !promise || !text.endsWith(promise)) return text;
  const head = text.slice(0, text.length - promise.length);
  return `${head}${head ? "due" : "Due"} ${when(ask.dueAt, now)}`;
}

const dot = (tone: string) => h("span", { class: "peek-dot-s", attrs: { "data-tone": tone, "aria-hidden": "true" } });

/** A section of the Ticket tab: a heading with its small note, then its box. */
const section = (title: string, aside: string, ...body: HTMLElement[]) =>
  h("section", { class: "peek-block" }, h("h3", { class: "peek-h peek-h-row" }, title, h("small", { class: "peek-aside" }, aside)), ...body);

const empty = (text: string) => h("p", { class: "peek-empty" }, text);

const linkChip = (use: string, href: string, label: string, value: string) =>
  h("a", { class: "peek-chip peek-pr", attrs: { href, target: "_blank", rel: "noopener noreferrer", "data-use": use } }, h("span", { class: "peek-k" }, label), h("b", {}, value));

const prChip = (number: number, repo: string) => linkChip("desks.chat.pr-link", prHref(number, repo), "PR", `#${number} ›`);

/** Brings Chat to the line an ask was asked in, once the sheet's Back has landed. */
const openLine = (id: string) =>
  leaveOverlays(() => {
    showLine(id, id);
    app.tab = "chat";
    changed();
  });

/** One linked ask in the Description: its writeup as written, then his words, its id, who asked, and where it came from and the row's PRs it names. */
function askView(ask: Ask, facts: PeekFacts): HTMLElement {
  const link = askSourceLink(ask, askLine(ask), facts.chats);
  const prs = linkedPrs(ask, facts.worker, facts.chats ?? [], facts.merged ?? []);
  const source = link
    ? "line" in link
      ? h("button", { class: "peek-chip peek-pr", attrs: { type: "button", "data-use": "desks.chat.open-line" }, on: { click: () => openLine(link.line) } }, h("b", {}, "Open in Chat ›"))
      : linkChip("desks.chat.issue-link", link.href, "Issue", `#${link.issue} ›`)
    : null;
  return h(
    "div",
    { class: "peek-ask" },
    ask.why ? h("p", { class: "peek-writeup" }, ask.why) : null,
    h("p", {}, h("q", { class: "peek-words" }, ask.words)),
    h("p", { class: "peek-from" }, `${ask.id} · ${askedBy(ask)}`),
    source || prs.length ? h("p", { class: "peek-sources" }, source, ...prs.map((pr) => prChip(pr.number, pr.repo))) : null,
  );
}

/** A fix chat's ops record in the Description: what holds it up, then what it is about, its state and when it is due. */
function recordView(record: OpsStatus, repo: string | undefined): HTMLElement {
  const writeup = record.cause ?? record.note ?? record.why;
  return h(
    "div",
    { class: "peek-ask" },
    writeup ? h("p", { class: "peek-writeup" }, writeup) : null,
    h("p", { class: "peek-from" }, [`Red: ${record.kind}`, record.key, STATE_LABEL[record.state], record.eta ? `due ${record.eta}` : null].filter(Boolean).join(" · ")),
    h(
      "p",
      { class: "peek-sources" },
      h("button", { class: "peek-chip peek-pr", attrs: { type: "button", "data-use": "desks.chat.open-ops" }, on: { click: () => openRecord(record, repo) } }, h("b", {}, "Open in Ops ›")),
    ),
  );
}

/** One Activity row: who, their role, when, then what. */
function activityView(row: ActivityRow): HTMLElement {
  return h(
    "li",
    { class: "peek-act", attrs: { "data-who": row.who } },
    h(
      "div",
      { class: "peek-act-top" },
      h("span", { class: "peek-act-name" }, row.name),
      h("span", { class: "peek-role" }, dot(row.who), row.role),
      row.at ? h("span", { class: "peek-act-at" }, when(row.at)) : null,
    ),
    h("p", { class: "peek-act-text" }, row.text, row.quote ? h("q", { class: "peek-words" }, row.quote) : null),
    row.attach ? h("span", { class: "peek-attach" }, row.attach) : null,
  );
}

/** Opens the chat sheet for a map row; `read` gives its facts as the map has them now, null once it has left the map. */
export function openChatPeek(w: Worker, read: () => PeekFacts | null, first: PeekTab = "ticket"): void {
  let facts = read() ?? { worker: w, title: chatName(w.chat), project: "", asks: [], stage: "", time: null, prs: [] };
  const face = rivet("working", { tone: "agent", size: 44, glow: true });
  const title = h("h2", { class: "peek-title" });
  const sub = h("p", { class: "peek-sub" });
  const close = h("button", { class: "decide-close", attrs: { type: "button", "aria-label": "Close", "data-use": "desks.chat.close" }, on: { click: () => closeTallSheet() } }, svg(ICONS.back, "btn-icon"));
  const strip = h("div", { class: "peek-strip" });
  const meta = h("p", { class: "peek-meta" });

  // The tabs.
  let tab: PeekTab = first;
  const count = h("span", { class: "peek-tab-n" });
  const tabButtons = TABS.map(({ key, label }, i) =>
    h(
      "button",
      { class: "peek-tab", attrs: { type: "button", role: "tab", "data-tab": key, "data-use": "desks.chat.tab", "data-use-value": String(i + 1) }, on: { click: () => show(key, true) } },
      label,
      key === "activity" ? count : null,
    ),
  );
  const tabs = h("div", { class: "peek-tabs", attrs: { role: "tablist", "aria-label": "Its chat" } }, ...tabButtons);

  // Ticket.
  const description = h("div", { class: "peek-box" });
  const descriptionAside = h("small", { class: "peek-aside" });
  const solution = h("div", { class: "peek-box" });
  const pictures = h("div", { class: "peek-pics" });
  const ticketPane = h(
    "div",
    { class: "peek-pane", attrs: { role: "tabpanel", "data-pane": "ticket" } },
    h("section", { class: "peek-block" }, h("h3", { class: "peek-h peek-h-row" }, "Description", descriptionAside), description),
    section("Solution", "what's being built", solution),
    section("Pictures", "from its cards", pictures),
  );

  // Activity.
  let who: (typeof WHO_CHIPS)[number]["key"] = "all";
  const chips = WHO_CHIPS.map(({ key, label }, i) =>
    h(
      "button",
      { class: "peek-chip peek-filter", attrs: { type: "button", "data-who": key, "aria-pressed": String(key === who), "data-use": "desks.chat.who", "data-use-value": String(i + 1) }, on: { click: () => ((who = key), paintActivity()) } },
      key === "all" ? null : dot(key),
      label,
    ),
  );
  const thread = h("ul", { class: "peek-thread" });
  const actNote = h("p", { class: "peek-empty peek-act-note" });
  const activityPane = h("div", { class: "peek-pane", attrs: { role: "tabpanel", "data-pane": "activity" } }, h("div", { class: "peek-filters" }, ...chips), thread, actNote);

  // Screen: as it was before the tabs.
  const note = h("p", { class: "peek-note" });
  const box = h("div", { class: "peek-screen", attrs: { tabindex: "0", role: "log", "aria-live": "off", "aria-label": `Its screen: ${chatName(w.chat)}` } }, "Loading…");
  const screenPane = h(
    "div",
    { class: "peek-pane", attrs: { role: "tabpanel", "data-pane": "screen" } },
    h("section", { class: "peek-block peek-screen-block" }, h("div", { class: "peek-screen-head" }, h("h3", { class: "peek-h" }, "Its screen"), note), box),
  );
  const panes = { ticket: ticketPane, activity: activityPane, screen: screenPane };

  const body = h(
    "div",
    { class: "peek-body" },
    h("header", { class: "peek-head" }, face, h("div", { class: "peek-who" }, title, sub), close),
    strip,
    meta,
    tabs,
    ticketPane,
    activityPane,
    screenPane,
  );

  const foot = holdFoot(box, 40);
  // Where the screen was left on a switch to another tab: hidden, the box reads 0 everywhere, so it is kept here.
  let screenLeft: { held: boolean; top: number } | null = null;
  function show(next: PeekTab, tapped = false): void {
    // A tap on the tab already open changes nothing: the screen keeps his place.
    if (tapped && next === tab) return;
    if (tab === "screen" && next !== "screen") screenLeft = { held: foot.held(), top: box.scrollTop };
    tab = next;
    for (const button of tabButtons) button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== tab;
    if (tab !== "screen") return;
    // Back at the newest line, unless he had scrolled up: then where he was.
    const left = screenLeft;
    screenLeft = null;
    if (left && !left.held) {
      box.scrollTop = left.top;
      foot.place(false);
    } else foot.place(true);
  }

  // What Activity and Ticket read: its cards (open on the board, answered in GET /api/answered) and its last words.
  let answered: AnsweredCard[] = [];
  let answeredAt = 0;
  let answeredState: "reading" | "read" | "failed" = "reading";
  let answeredRead = 0;
  let answeredRetry: ReturnType<typeof setTimeout> | undefined;
  let lastSaid: { text: string; at: string | null } | null = null;
  let open = true;
  // The ask whole: the asks list's rows carry only their newest timeline event, so Activity reads GET /api/asks/:id.
  let wholeAsk: Ask | null = null;
  let askRead = 0;
  // The ask and version last asked for: a list row naming another ask, or a newer version, reads it again at once.
  let askWanted = "";
  const readAsk = () => {
    const id = facts.ask?.id;
    if (!id) return;
    askWanted = `${id}@${facts.ask!.version}`;
    const read = ++askRead;
    api.getAsk(id).then(
      (next) => {
        if (!open || read !== askRead || next.id !== facts.ask?.id) return;
        wholeAsk = next;
        paintTicket();
      },
      // Unread, Activity keeps the list's newest event.
      () => undefined,
    );
  };
  const readAnswered = () => {
    answeredAt = Date.now();
    readAsk();
    clearTimeout(answeredRetry);
    // Only the newest read lands: a slow older one never puts back a list without an answer he has just given.
    const read = ++answeredRead;
    api.getAnswered().then(
      (next) => {
        if (!open || read !== answeredRead) return;
        answered = next.cards;
        answeredState = "read";
        paintTicket();
      },
      () => {
        if (!open || read !== answeredRead) return;
        // A list already read stays; with none, Ticket says it could not read its cards, and tries again soon.
        if (answeredState !== "read") answeredState = "failed";
        answeredRetry = setTimeout(() => open && readAnswered(), ANSWERED_RETRY_MS);
        paintTicket();
      },
    );
  };

  let rows: ActivityRow[] = [];
  const paintActivity = () => {
    for (const chip of chips) chip.setAttribute("aria-pressed", String(chip.dataset.who === who));
    const shownRows = who === "all" ? rows : rows.filter((row) => row.who === who);
    thread.replaceChildren(...shownRows.map(activityView));
    thread.hidden = shownRows.length === 0;
    actNote.textContent = shownRows.length === 0 ? WHO_EMPTY[who] : "";
    if (answeredState === "reading") actNote.textContent = [actNote.textContent, "Reading its cards…"].filter(Boolean).join(" ");
    if (answeredState === "failed") actNote.textContent = [actNote.textContent, "Could not read its cards' answers."].filter(Boolean).join(" ");
    count.textContent = rows.length ? String(rows.length) : "";
    count.hidden = rows.length === 0;
  };

  let ticketKey = "";
  const paintTicket = () => {
    // The whole ask while it is the same one and no older than the list's row.
    const listed = facts.ask;
    if (listed && `${listed.id}@${listed.version}` !== askWanted && !(wholeAsk?.id === listed.id && wholeAsk.version >= listed.version)) readAsk();
    // A list row newer than the whole ask read: the whole ask's history with the row's newest event, until the read lands.
    const ask =
      listed && wholeAsk?.id === listed.id
        ? wholeAsk.version >= listed.version
          ? wholeAsk
          : { ...listed, timeline: [...wholeAsk.timeline, ...listed.timeline.filter((event) => !wholeAsk!.timeline.some((one) => one.at === event.at))] }
        : listed;
    const linked = facts.asks.length ? facts.asks : listed ? [listed] : [];
    // A row the map builds from GitHub or the push queue has no chat of its own; a chat's row does.
    const mapRow = w.id.includes(":");
    // `tied`: only the cards that name the ask, never its chat's other cards, which may be a newer ask's.
    const cardsOf = (one: Ask | undefined, tied = false) =>
      ticketCards(one, tied ? "" : (one?.chat ?? w.chat), one ? [askPrRepo(one, w), w.project, w.repo] : [w.project, w.repo], app.board?.board?.needs ?? [], answered, w.startedAt);
    // A chat's own asks hold its cards. With none, its own cards stay, with those it sent naming an ask it is linked to. A map
    // row's linked asks hold only the cards that name them, even when the row borrows its ask's chat name.
    const own = new Set(asksOfChat(w, linked).map((one) => one.id));
    const holders = own.size ? linked.filter((one) => own.has(one.id)) : mapRow ? linked : [];
    const cards = mergedCards(
      holders.length
        ? holders.map((one) => cardsOf(one.id === ask?.id ? ask : one, mapRow || !own.has(one.id)))
        : [cardsOf(undefined), ...linked.map((one) => cardsOf(one, true).filter((entry) => entry.card.chat === w.chat))],
    );
    rows = activityRows(ask, ask?.chat ?? w.chat, cards, lastSaid);
    paintActivity();
    const pics = ticketPictures(cards);
    const plan = ticketSolution(cards);
    // Until its cards are read, Ticket says so rather than that they do not exist.
    const unread = answeredState === "reading" ? "Reading its cards…" : answeredState === "failed" ? "Could not read its cards. Trying again shortly." : null;
    // A chat with no ask of its own shows its ops record first, before an ask that only names its PR.
    const record = own.size || mapRow ? undefined : opsRecordOf(w, opsData.statuses ?? []);
    const prsOnly = !linked.length && !record ? facts.prs : [];
    // A map row's doing text is its PR's number and title; a chat's is its own words, never the PR's.
    const prTitle = w.id.includes(":") ? facts.worker.what?.replace(/^#\d+ /, "") : undefined;
    const key = JSON.stringify([
      linked.map((one) => [one.id, one.words, one.why, one.who, one.createdAt, one.source, one.replyId, one.issue, linkedPrs(one, facts.worker, facts.chats ?? [], facts.merged ?? [])]),
      record,
      prsOnly,
      prTitle,
      plan,
      pics,
      answeredState,
    ]);
    if (key === ticketKey) return;
    ticketKey = key;
    const first = linked[0];
    descriptionAside.textContent = linked.length > 1 ? `${linked.length} asks` : !first ? "" : first.why || first.who !== "owner" ? "the ask" : "your words";
    description.replaceChildren(
      ...(linked.length || record
        ? [...(record ? [recordView(record, w.repo || undefined)] : []), ...linked.map((one) => askView(one, facts))]
        : prsOnly.length
            ? [prTitle ? h("p", {}, prTitle) : null, h("p", { class: "peek-sources" }, ...prsOnly.map((pr) => prChip(pr.number, pr.repo)))].flatMap((one) => (one ? [one] : []))
            : [empty("No ask is linked to this chat.")]),
    );
    solution.replaceChildren(
      ...(plan
        ? [
            h("p", {}, plan.lead),
            plan.points.length ? h("ul", { class: "peek-points" }, ...plan.points.map((point) => h("li", {}, point))) : null,
            plan.rows.length ? h("dl", { class: "peek-kv" }, ...plan.rows.flatMap(([term, value]) => [h("dt", {}, term), h("dd", {}, value)])) : null,
          ].flatMap((one) => (one ? [one] : []))
        : [empty(unread ?? "No plan card for this yet. What's being built shows here once one is sent.")]),
    );
    pictures.replaceChildren(
      ...(pics.length
        ? pics.map((pic, i) =>
            h(
              "button",
              {
                class: "peek-pic",
                attrs: { type: "button", "data-use": "desks.chat.picture", "aria-label": `Open picture: ${pic.title}` },
                // One label for the set (each picture's card shows under it here), and Share as on the cards.
                on: {
                  click: () =>
                    openImages(
                      pics.map((one) => one.src),
                      i,
                      "Picture",
                      (n, signal) => fetchDocument(pics[n]!.src, mediaName(pics[n]!.title, `picture-${n + 1}`, pics[n]!.ref), pics[n]!.ref.type, signal),
                    ),
                },
              },
              h("img", { attrs: { src: pic.src, alt: "", loading: "lazy", decoding: "async" } }),
              h("span", { class: "peek-pic-cap" }, h("span", { class: "peek-pic-title" }, pic.title), pic.at ? h("span", { class: "peek-pic-at" }, when(pic.at)) : null),
            ),
          )
        : [empty(unread ?? "No pictures on its cards yet.")]),
    );
    pictures.classList.toggle("is-empty", pics.length === 0);
  };

  let shown = "";
  // Why its screen has not come, once it has waited LOG_SLOW_MS: never an endless "Waiting".
  let slowWhy: string | null = null;
  let latest: LogsResponse | null = null;
  /** Paints a read: the newest at the foot, kept in view unless you have scrolled up. */
  const paintScreen = (logs: LogsResponse) => {
    latest = logs;
    if (logs.lines.length) slowWhy = null;
    const key = `${slowWhy ?? ""}\n${logs.lines.join("\n")}\n${(logs.times ?? []).join("\n")}`;
    if (key === shown) return;
    const fresh = shown === "";
    shown = key;
    // Hidden on another tab, the box reads 0 everywhere: it keeps where he left it.
    const atFoot = fresh || (box.clientHeight === 0 ? (screenLeft?.held ?? true) : box.scrollHeight - box.scrollTop - box.clientHeight < 40);
    // Set out and redacted again by the server (redactScreen): the lines alone are masked one by one.
    const items = logs.screen ?? [];
    if (items.length) box.replaceChildren(...items.map(itemView));
    else box.textContent = logs.lines.length ? "Nothing to read on its screen yet." : (slowWhy ?? "Waiting for its screen…");
    foot.place(atFoot);
    // Its last words as the box reads them; a tool under way (`⏺ Reading the notes`) is not something it said.
    const last = [...items].reverse().find((item) => item.kind === "said");
    if (last) {
      // When it said them, if the feed has them as they arrived (the feed shortens paths, so a start is enough).
      const words = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 40);
      const at = (logs.feed ?? []).find((entry) => entry.kind === "said" && words(entry.text) === words(last.text))?.at ?? null;
      lastSaid = { text: last.text, at };
    } else lastSaid = null;
    paintTicket();
  };

  const openChat = () => {
    return !!app.workers?.workers.some((one) => one.repo === w.repo && one.chat === w.chat);
  };
  let log: { stop(): void } | null = null;
  let gone: string | null | undefined;
  let stripKey = "";
  const paint = () => {
    facts = read() ?? facts;
    title.textContent = facts.title;
    sub.textContent = [chatName(facts.worker.chat), facts.project].filter(Boolean).join(" · ");
    const chipsNow: HTMLElement[] = [];
    if (facts.stage) chipsNow.push(h("span", { class: "peek-chip peek-stage" }, dot(facts.stageKey ?? "building"), facts.stage));
    for (const pr of facts.prs)
      chipsNow.push(
        h(
          "a",
          { class: "peek-chip peek-pr", attrs: { href: prHref(pr.number, pr.repo), target: "_blank", rel: "noopener noreferrer", "data-use": "desks.chat.pr-link" } },
          h("span", { class: "peek-k" }, "PR"),
          h("b", {}, `#${pr.number} ›`),
        ),
      );
    if (facts.time) chipsNow.push(h("span", { class: `peek-chip peek-time${facts.time.tone ? ` is-${facts.time.tone}` : ""}` }, dueText(facts)));
    const nextStrip = chipsNow.map((one) => one.outerHTML).join("");
    if (nextStrip !== stripKey) {
      stripKey = nextStrip;
      strip.replaceChildren(...chipsNow);
    }
    strip.hidden = chipsNow.length === 0;
    meta.textContent = ticketMeta(facts.ask);
    meta.hidden = meta.textContent === "";
    if (Date.now() - answeredAt > ANSWERED_EVERY_MS) readAnswered();
    paintTicket();
    const why = screenGone(w, openChat());
    if (why === gone) return;
    gone = why;
    log?.stop();
    log = null;
    shown = "";
    slowWhy = null;
    latest = null;
    if (why) {
      note.textContent = "";
      box.textContent = why;
      box.dataset.state = "gone";
      lastSaid = null;
      paintTicket();
      return;
    }
    delete box.dataset.state;
    box.textContent = "Loading…";
    note.textContent = "Starting…";
    log = liveLog(
      w,
      (state, text) => {
        note.dataset.state = state;
        note.textContent = state === "on" ? "Masked on the Mac · every 2s" : text;
      },
      paintScreen,
      (text) => {
        if (log === null || text === slowWhy) return;
        slowWhy = text;
        paintScreen(latest ?? { repo: w.repo, chat: w.chat, lines: [], times: [], updatedAt: null, leaseUntil: null });
      },
    );
  };

  let stop = () => {};
  openTallSheet(
    `${chatName(w.chat)}: its chat`,
    {
      mount(el) {
        el.replaceChildren(body);
        show(tab);
        const unsubscribe = subscribe(paint);
        const unwatchAsks = watchAsks(paint);
        const unwatchStatuses = watchStatuses(paint);
        stop = () => {
          open = false;
          clearTimeout(answeredRetry);
          unsubscribe();
          unwatchAsks();
          unwatchStatuses();
          log?.stop();
          log = null;
          foot.stop();
        };
        paint();
      },
      unmount: () => stop(),
    },
    { className: "peek-sheet", use: "desks.chat" },
  );
}
