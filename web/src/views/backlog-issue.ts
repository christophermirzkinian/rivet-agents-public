import type { BacklogIssueResponse, BacklogStart, IssueDetail } from "../../../src/shared/backlog.js";
import { shortDate } from "../../../src/shared/when.js";
import { closeBacklogIssue, getBacklogIssue, startBacklogIssue } from "../api.js";
import { startedWords } from "../backlog-logic.js";
import { h, ICONS, svg } from "../dom.js";
import { app, changed as appChanged } from "../state.js";
import { projectName } from "../backlog-logic.js";
import { startDraft } from "./chat.js";
import { flash } from "./toast.js";
import { leaveTallSheet } from "./sheet.js";
import { formattable, lexMarkdown, markdownDom } from "./text-pages.js";
import { openChatSheet } from "./worker-sheet.js";

// An issue opened from a project's backlog in the backlog's own tall
// sheet: what its author wrote, read from GitHub by the Mac on tap, then Start work, Ask Rivet, Close and GitHub.
// Back, Escape and ‹ go back to the list.

/** How often the page asks again while the Mac reads the issue, and when it gives up. */
export const POLL_MS = 1500;
export const READ_GIVE_UP_MS = 20_000;
/** How long a first tap on Close stays armed. */
export const ARMED_MS = 5000;

export interface IssuePage {
  /** History entries the page pushed over the sheet's own. */
  depth(): number;
  /** The sheet closed under it: stop polling and listening. */
  leave(): void;
}

export interface IssueOpen {
  repo: BacklogStart["repo"];
  issue: number;
  /** The row's title, shown until the issue is read. */
  title: string;
  start?: BacklogStart;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const clientId = () => crypto.randomUUID().replace(/-/g, "");

/**
 * Shows the issue in `content` in place of the list's `list` nodes, which are kept as they are (scroll and "N more"
 * included) and put back by `back`. `back(changed)` hears whether Start work or Close changed the list.
 */
export function openIssuePage(content: HTMLElement, list: HTMLElement[], open: IssueOpen, back: (changed: boolean) => void): IssuePage {
  const { repo, issue } = open;
  const scrolls = list.map((el) => el.scrollTop);
  const github = `https://github.com/${repo}/issues/${issue}`;
  let alive = true;
  let pushed = false;
  let changed = false;
  let read: BacklogIssueResponse | null = null;
  let start: BacklogStart | null = open.start ?? null;
  let failed = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let armed: ReturnType<typeof setTimeout> | undefined;
  let shownBody: string | null = null;
  const startId = clientId();
  const closeId = clientId();
  const began = Date.now();

  const sub = h("p", { class: "backlog-head-sub" }, "Issue");
  const backButton = h(
    "button",
    { class: "decide-close backlog-issue-back", attrs: { type: "button", "aria-label": "Back to the list", "data-use": "backlog.issue.back" }, on: { click: () => goBack() } },
    svg(ICONS.back, "btn-icon"),
  );
  const head = h("header", { class: "floor-sheet-head backlog-head" }, backButton, h("div", { class: "backlog-head-text" }, h("h2", { class: "floor-sheet-title" }, `${projectName(repo)} · #${issue}`), sub));
  const title = h("h3", { class: "backlog-issue-title" }, open.title);
  const meta = h("p", { class: "backlog-issue-meta" }, "Reading it from GitHub…");
  const chips = h("div", { class: "backlog-issue-chips" });
  const chat = h("div", { class: "backlog-issue-chat" });
  const md = h("div", { class: "backlog-md" });
  const body = h("div", { class: "floor-sheet-body backlog-body backlog-issue-body" }, title, meta, chips, chat, md);
  const startButton = h("button", { class: "backlog-btn is-primary", attrs: { type: "button", "data-use": "backlog.issue.start" }, on: { click: () => void doStart() } }, "Start work");
  const askButton = h("button", { class: "backlog-btn", attrs: { type: "button", "data-use": "backlog.issue.ask" }, on: { click: () => askRivet() } }, "Ask Rivet");
  const closeButton = h("button", { class: "backlog-btn is-close", attrs: { type: "button", "data-use": "backlog.issue.close" }, on: { click: () => void doClose() } }, "Close issue");
  const note = h("p", { class: "backlog-issue-note" });
  note.hidden = true;
  const foot = h(
    "div",
    { class: "backlog-foot backlog-issue-foot" },
    h(
      "div",
      { class: "backlog-btns" },
      startButton,
      askButton,
      closeButton,
      h("a", { class: "backlog-btn is-wide", attrs: { href: github, target: "_blank", rel: "noopener", "data-use": "backlog.issue.github" } }, "Open on GitHub ›"),
    ),
    note,
  );

  const detail = (): IssueDetail | null => read?.detail ?? null;
  const shownTitle = () => detail()?.title ?? open.title;

  function paint(): void {
    const d = detail();
    title.textContent = shownTitle();
    sub.textContent = `Issue · ${d?.state ?? "open"}`;
    if (d) {
      meta.replaceChildren("Opened by ", h("b", {}, d.author ?? "someone"), ` · ${shortDate(d.createdAt, Date.now())} · ${plural(d.comments, "comment")}`);
      chips.replaceChildren(...(d.labels.length ? d.labels.map((label) => h("span", { class: "backlog-tag is-label" }, label)) : [h("span", { class: "backlog-tag is-label" }, "No labels")]));
    } else meta.textContent = failed ? "Could not read it from GitHub. Open on GitHub below." : "Reading it from GitHub…";
    const on = start?.chat ?? read?.chat ?? null;
    chat.replaceChildren(
      on
        ? h("button", { class: "backlog-issue-on", attrs: { type: "button", "data-use": "backlog.issue.chat" }, on: { click: () => leaveTallSheet(() => openChatSheet(on, repo, start ? `ask-${start.ask}` : `issue-${repo}#${issue}`, "backlog")) } }, `On it: ${on}`, h("span", { class: "backlog-go", attrs: { "aria-hidden": "true" } }, "›"))
        : h("span", {}, d || start ? "No chat on this yet." : ""),
    );
    chat.hidden = !on && !d && !start;
    if (d && d.body !== shownBody) void paintBody(d.body);
    if (start) {
      startButton.className = "backlog-btn is-primary is-done";
      startButton.textContent = startedWords(start.at, Date.now());
      startButton.setAttribute("aria-disabled", "true");
    }
    const close = read?.close;
    if (close && close.status !== "failed") {
      disarm();
      closeButton.className = "backlog-btn is-close";
      closeButton.textContent = close.status === "done" ? "Closed" : "Closing…";
      closeButton.setAttribute("aria-disabled", "true");
    }
  }

  async function paintBody(source: string): Promise<void> {
    shownBody = source;
    if (!source.trim()) {
      md.replaceChildren(h("p", { class: "backlog-note" }, "No description."));
      return;
    }
    const tokens = formattable(source) ? await lexMarkdown(source) : null;
    if (!alive || shownBody !== source) return;
    md.replaceChildren(tokens ? markdownDom(tokens) : h("p", { class: "backlog-md-plain" }, source));
  }

  async function fetchIssue(): Promise<void> {
    poll = undefined;
    try {
      const got = await getBacklogIssue(repo, issue);
      if (!alive) return;
      read = got;
      if (got.start) start = got.start;
      if (got.pending && Date.now() - began < READ_GIVE_UP_MS) poll = setTimeout(() => void fetchIssue(), POLL_MS);
      else if (!got.detail) failed = true;
    } catch {
      if (!alive) return;
      failed = !detail();
    }
    paint();
  }

  async function doStart(): Promise<void> {
    if (start || startButton.getAttribute("aria-busy") === "true") return;
    startButton.setAttribute("aria-busy", "true");
    startButton.textContent = "Starting…";
    try {
      const got = await startBacklogIssue(repo, issue, startId);
      if (!alive) return;
      changed = true;
      start = got.start ?? { repo, issue, ask: got.ask, words: "", at: new Date().toISOString(), stage: "queued" };
    } catch {
      if (alive) startButton.textContent = "Could not start. Tap to try again.";
    } finally {
      startButton.removeAttribute("aria-busy");
    }
    if (alive) paint();
  }

  function askRivet(): void {
    const prefix = `About ${repo} #${issue}: ${shownTitle()} — `;
    leaveTallSheet(() => {
      const named = startDraft(prefix);
      app.tab = "chat";
      appChanged();
      if (!named) flash("Your unsent message is too long to add this issue to. Send or shorten it first.", "warn", 5000);
    });
  }

  function disarm(): void {
    clearTimeout(armed);
    armed = undefined;
    note.hidden = true;
    closeButton.className = "backlog-btn is-close";
    closeButton.textContent = "Close issue";
  }

  async function doClose(): Promise<void> {
    if (closeButton.getAttribute("aria-disabled") === "true" || closeButton.getAttribute("aria-busy") === "true") return;
    if (!armed) {
      closeButton.className = "backlog-btn is-close is-armed";
      closeButton.textContent = "Tap again to close";
      note.textContent = `Closes #${issue} as not needed, with a comment.`;
      note.hidden = false;
      armed = setTimeout(disarm, ARMED_MS);
      return;
    }
    clearTimeout(armed);
    armed = undefined;
    note.hidden = true;
    closeButton.setAttribute("aria-busy", "true");
    closeButton.textContent = "Closing…";
    try {
      await closeBacklogIssue(repo, issue, closeId);
      if (!alive) return;
      changed = true;
      goBack();
    } catch {
      if (!alive) return;
      closeButton.removeAttribute("aria-busy");
      closeButton.className = "backlog-btn is-close";
      closeButton.textContent = "Could not close. Tap to try again.";
    }
  }

  function stop(): void {
    alive = false;
    clearTimeout(poll);
    clearTimeout(armed);
    window.removeEventListener("popstate", onPop);
    window.removeEventListener("keydown", onKey, true);
  }

  function showList(): void {
    if (!alive) return;
    stop();
    content.replaceChildren(...list);
    list.forEach((el, i) => (el.scrollTop = scrolls[i] ?? 0));
    back(changed);
  }

  /** ‹ goes Back when the page has an entry of its own, so the phone's Back is not left one too many. */
  function goBack(): void {
    if (pushed) {
      pushed = false;
      history.back();
      return showList();
    }
    showList();
  }

  // The sheet's own popstate listener keeps it open on its own entry, which Back from this page lands on.
  const onPop = () => {
    pushed = false;
    showList();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || document.querySelector(".lightbox")) return;
    event.stopPropagation();
    goBack();
  };

  content.replaceChildren(head, body, foot);
  try {
    history.pushState(history.state, "");
    pushed = true;
  } catch {
    // Without its entry Back closes the sheet; ‹ and Escape still go back to the list.
  }
  window.addEventListener("popstate", onPop);
  window.addEventListener("keydown", onKey, true);
  paint();
  void fetchIssue();
  backButton.focus({ preventScroll: true });

  return {
    depth: () => (alive && pushed ? 1 : 0),
    leave: stop,
  };
}
