import "./sheets.css";

import { stepsOf } from "../../../src/shared/answers.js";
import { chatRepo } from "../../../src/shared/board.js";
import { MIN_QUERY, rankSearch, type SearchItem, type SearchTarget } from "../../../src/shared/search.js";
import type { Worker } from "../../../src/shared/workers.js";
import * as api from "../api.js";
import { h } from "../dom.js";
import { opsData, refreshOps } from "../ops-data.js";
import { app, changed, go, navStamp } from "../state.js";
import { useTap } from "../usage.js";
import { showAnswered } from "./answered.js";
import { comingRowRepo, shownComing } from "./board.js";
import { openBriefingHistory } from "./briefing-history.js";
import { setComingFilter } from "./coming-filter.js";
import { showCard, showList } from "./feed.js";
import { focusSection } from "./ops.js";
import { closeSheet } from "./sheet.js";
import { openWorkerSheet } from "./worker-sheet.js";
import { onSessionReset } from "../session.js";
import { registerSearchSource, searchSources } from "./search-sources.js";
import { RIVET_NAME, chatName } from "../../../src/shared/names.js";

// The header search. Each source turns data the app already holds into items;
// another area adds its own with registerSearchSource.

export { registerSearchSource, searchSources, type SearchSource } from "./search-sources.js";

const DEBOUNCE_MS = 180;
let workers: Worker[] = [];
onSessionReset(() => {
  workers = [];
});

registerSearchSource("board", () => {
  const board = app.board?.board;
  if (!board) return [];
  const items: SearchItem[] = [];
  for (const need of board.needs)
    items.push({ kind: "card", key: `card:${need.id}`, title: need.title, detail: [need.ask, ...stepsOf(need), need.chat ? chatName(need.chat) : "", need.pr ? `#${need.pr}` : ""].filter(Boolean).join(" "), open: { type: "card", id: need.id } });
  for (const chat of board.chats)
    // Keyed by repo too: two repos' chats can share a name, and a key is kept once.
    items.push({ kind: "chat", key: `chat:${chatRepo(chat) ?? ""}/${chat.name}`, title: chatName(chat.name), detail: [chatRepo(chat) ?? "", chat.state, chat.doing, typeof chat.what === "string" ? chat.what : "", typeof chat.stage === "string" ? chat.stage : ""].filter(Boolean).join(" "), open: { type: "chat", name: chat.name, ...(chatRepo(chat) ? { repo: chatRepo(chat) } : {}) } });
  for (const item of shownComing(board)) {
    const repo = comingRowRepo(board.chats, item);
    items.push({
      kind: "coming",
      key: `coming:${repo === null ? `?${item.chat}` : (repo ?? "")}/${item.pr ?? `${item.app ?? ""}:${item.title}`}`,
      title: item.title,
      detail: [item.app, item.what, item.pr ? `#${item.pr}` : "", "coming"].filter(Boolean).join(" "),
      open: { type: "tab", tab: "feed", section: "coming" },
    });
  }
  for (const item of board.shipped)
    items.push({ kind: "shipped", key: `shipped:${item.pr ? `${item.repo ?? ""}#${item.pr}` : item.title}`, title: item.title, detail: [item.pr ? `#${item.pr}` : "", "shipped", item.liveNote].filter(Boolean).join(" "), open: { type: "tab", tab: "agents", section: "timeline" } });
  return items;
});

registerSearchSource("replies", () =>
  app.recent.map((reply) => ({
    kind: "reply" as const,
    key: `reply:${reply.id}`,
    title: reply.itemTitle,
    detail: [reply.decision, reply.choice, reply.text].filter(Boolean).join(" "),
    at: reply.at,
    open: { type: "reply", id: reply.id } as const,
  })),
);

registerSearchSource("workers", () =>
  workers.map((worker) => ({
    kind: "worker" as const,
    key: `worker:${worker.id}`,
    title: chatName(worker.chat),
    detail: [worker.name, worker.state, worker.doing, worker.repo.split("/").pop()].filter(Boolean).join(" "),
    repo: worker.repo,
    open: { type: "worker", id: worker.id } as const,
  })),
);

registerSearchSource("ops", () => {
  const items: SearchItem[] = [];
  for (const pr of opsData.ops?.github?.prs ?? [])
    items.push({
      kind: "pr",
      key: `pr:${pr.repo}#${pr.number}`,
      title: `#${pr.number} ${pr.title}`,
      detail: [pr.repo.split("/").pop(), pr.author, ...(pr.draft ? ["draft"] : []), ...pr.labels, ...pr.checks.failing].join(" "),
      at: pr.updatedAt,
      repo: pr.repo,
      open: { type: "url", url: pr.url },
    });
  for (const day of opsData.timeline?.days ?? [])
    for (const event of day.events)
      items.push({
        kind: "timeline",
        key: event.number ? `pr:${event.repo}#${event.number}` : event.app ? `deploy:${event.app}:${event.title}` : `${event.kind}:${event.title}`,
        title: event.number ? `#${event.number} ${event.title}` : event.title,
        detail: `${event.kind} ${day.day}`,
        at: event.at,
        repo: event.repo,
        open: event.url ? { type: "url", url: event.url } : { type: "tab", tab: "agents", section: "timeline" },
      });
  return items;
});

const KIND_LABEL: Record<string, string> = {
  card: "Card",
  coming: "Coming",
  shipped: "Shipped",
  reply: "Your answer",
  worker: "Worker",
  chat: "Agent",
  message: `${RIVET_NAME} chat`,
  pr: "Pull request",
  timeline: "Timeline",
  briefing: "Briefing",
};

const KIND_TONE: Record<string, string> = { card: "bad", pr: "info", worker: "warn", timeline: "info" };

/** Every local source's items; a source that throws is left out. */
export async function localItems(query = ""): Promise<SearchItem[]> {
  const all = await Promise.all([...searchSources.values()].map((source) => Promise.resolve(query).then(source).catch(() => [] as SearchItem[])));
  return all.flat();
}

/** Bumped by every pick: a reply still loading for an earlier one no longer navigates. */
let picks = 0;

export function openTarget(target: SearchTarget): void {
  const pick = ++picks;
  closeSheet();
  if (target.type === "card") {
    showCard(target.id);
  } else if (target.type === "briefing") {
    openBriefingHistory(target.id);
  } else if (target.type === "tab") {
    if (target.tab === "feed") {
      if (target.section === "coming") setComingFilter("all");
      showList();
    } else if (target.section) {
      focusSection(target.section);
    } else {
      go(target.tab);
      changed();
    }
  } else if (target.type === "chat") {
    // Its worker's sheet, idle or blocked too; a target naming no repo is the one live chat of the name.
    const named = app.workers?.workers.filter((item) => item.chat === target.name) ?? [];
    const worker = target.repo ? named.find((item) => item.repo === target.repo) : named.length === 1 ? named[0] : undefined;
    if (worker) openWorkerSheet(worker);
    else {
      app.tab = "progress";
      changed();
    }
  } else if (target.type === "reply") {
    // An answer opens on Cards › Answered, its row lit.
    const id = target.id;
    const known = app.recent.find((reply) => reply.id === id);
    if (known) showAnswered(known);
    else {
      const stamp = navStamp();
      const current = () => pick === picks && navStamp() === stamp;
      api.getReply(id).then(
        (reply) => current() && showAnswered(reply),
        () => current() && showAnswered(),
      );
    }
  } else if (target.type === "message") {
    app.chatFocus = target.id;
    app.tab = "chat";
    changed();
  } else if (target.type === "url") {
    if (/^https:\/\//.test(target.url)) window.open(target.url, "_blank", "noopener,noreferrer");
  } else {
    const worker = workers.find((item) => item.id === target.id);
    if (worker) openWorkerSheet(worker);
  }
}

let timer: number | null = null;
let generation = 0;

export function mount(el: HTMLElement): void {
  unmount();
  const input = h("input", {
    class: "srch-input",
    attrs: { type: "search", placeholder: "Cards, PRs, agents…", "aria-label": "Search", autocomplete: "off", enterkeyhint: "search" },
  });
  const status = h("p", { class: "srch-status", attrs: { role: "status" } }, `Type ${MIN_QUERY} or more letters.`);
  const list = h("ul", { class: "srch-results" });
  el.replaceChildren(h("div", { class: "srch" }, input, status, list));

  const show = (results: SearchItem[], query: string, pending: boolean) => {
    list.replaceChildren(
      ...results.map((item) =>
        h(
          "li",
          {},
          h(
            "button",
            { class: "srch-hit box", attrs: { type: "button", "data-use": item.kind === "reply" ? "search.hit.answer" : item.kind === "chat" ? "search.hit.agent" : item.kind === "message" ? "search.hit.chat" : `search.hit.${item.kind}` }, on: { click: () => openTarget(item.open) } },
            h("span", { class: `srch-kind t-${KIND_TONE[item.kind] ?? "idle"}` }, KIND_LABEL[item.kind] ?? "Result"),
            h("span", { class: "srch-title" }, item.title),
            item.detail ? h("span", { class: "srch-detail" }, item.detail) : null,
          ),
        ),
      ),
    );
    status.textContent = query.trim().length < MIN_QUERY
      ? `Type ${MIN_QUERY} or more letters.`
      : results.length
        ? `${results.length} ${results.length === 1 ? "match" : "matches"}${pending ? ", searching history…" : ""}`
        : pending
          ? "Searching…"
          : "No matches.";
  };

  const run = async () => {
    const query = input.value;
    const mine = ++generation;
    if (query.trim().length < MIN_QUERY) return show([], query, false);
    const local = await localItems(query.trim());
    if (mine !== generation) return;
    show(rankSearch(local, query, Date.now()), query, true);
    const history = await api.searchHistory(query.trim()).then(
      (response) => response.results,
      () => [] as SearchItem[],
    );
    if (mine !== generation) return;
    show(rankSearch([...local, ...history], query, Date.now()), query, false);
  };

  input.addEventListener("input", () => {
    // An answer to what was typed before never shows under this.
    generation += 1;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const first = list.querySelector("button");
    if (!(first instanceof HTMLButtonElement)) return;
    useTap("search.enter");
    first.click();
  });
  if (!opsData.at) void refreshOps();
  // The sheet focuses its Close button; search wants the field.
  queueMicrotask(() => input.focus());

  api.getWorkers().then(
    (response) => {
      workers = response.workers;
    },
    () => {},
  );
}

export function unmount(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  generation += 1;
}
