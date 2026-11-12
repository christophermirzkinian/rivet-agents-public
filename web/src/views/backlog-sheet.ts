import "./backlog-sheet.css";

import type { BacklogResponse } from "../../../src/shared/backlog.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import { when } from "../../../src/shared/when.js";
import { getBacklog } from "../api.js";
import { backlogOf, moreLabel, projectName, TAG_WORDS, type BacklogRow, type BacklogSection } from "../backlog-logic.js";
import { h, ICONS, svg } from "../dom.js";
import { freshPrs, opsData, watchOps } from "../ops-data.js";
import { app } from "../state.js";
import { openIssuePage, type IssuePage } from "./backlog-issue.js";
import { closeTallSheet, leaveTallSheet, openTallSheet } from "./sheet.js";
import { openChatSheet } from "./worker-sheet.js";

// A project chip's sheet: the issues Start work began, its asks not started or parked, the issues waiting on your call,
// the drafts nobody is on and its other issues. An ask opens its chat; an issue opens in the sheet (backlog-issue.ts);
// a PR opens GitHub.

/** An ask opens its chat, as Your asks does; one with no chat opens the issue it names. */
function openRow(row: BacklogRow, openIssue: (row: BacklogRow) => void): void {
  if (row.issue !== null) return openIssue(row);
  const ask = row.ask;
  if (ask?.chat) {
    const chat = ask.chat;
    return leaveTallSheet(() => openChatSheet(chat, ask.repo ?? (NO_REPO || undefined), `ask-${ask.id}`, "backlog"));
  }
  if (row.url) window.open(row.url, "_blank", "noopener");
}

function rowEl(row: BacklogRow, openIssue: (row: BacklogRow) => void): HTMLElement {
  const parts = [
    h("span", { class: `backlog-tag is-${row.tag}` }, TAG_WORDS[row.tag]),
    h("span", { class: "backlog-text" }, h("b", { class: "backlog-title" }, row.title), row.sub ? h("small", { class: "backlog-sub" }, row.sub) : null),
  ];
  if (!row.ask?.chat && !row.url) return h("div", { class: "backlog-row", attrs: { "data-key": row.key } }, ...parts);
  const use = row.issue !== null ? "backlog.issue" : row.ask ? "backlog.ask" : "backlog.github";
  return h(
    "button",
    { class: `backlog-row is-${row.tag}`, attrs: { type: "button", "data-key": row.key, "data-use": use }, on: { click: () => openRow(row, openIssue) } },
    ...parts,
    h("span", { class: "backlog-go", attrs: { "aria-hidden": "true" } }, "›"),
  );
}

function sectionEl(section: BacklogSection, openIssue: (row: BacklogRow) => void): HTMLElement {
  const rowOf = (row: BacklogRow) => rowEl(row, openIssue);
  const list = h("div", { class: "backlog-rows" }, ...section.rows.slice(0, section.shown).map(rowOf));
  const label = moreLabel(section);
  const more = label
    ? h(
        "button",
        {
          class: "backlog-more",
          attrs: { type: "button", "data-use": "backlog.more" },
          on: {
            click: () => {
              list.append(...section.rows.slice(section.shown).map(rowOf));
              more?.remove();
            },
          },
        },
        label,
      )
    : null;
  return h(
    "section",
    { class: "backlog-section", attrs: { "data-section": section.id } },
    h("h3", { class: "backlog-heading" }, section.title, section.count !== null ? h("span", { class: "backlog-count" }, String(section.count)) : null),
    list,
    more,
  );
}

/** Opens `repo`'s backlog: a loading line, then the sheet as read. */
export function openBacklog(repo: string): void {
  const sub = h("p", { class: "backlog-head-sub" }, "Loading…");
  const body = h("div", { class: "home-sheet-body backlog-body" });
  const foot = h("div", { class: "backlog-foot" });
  let alive = true;
  let read: BacklogResponse | null = null;
  let unwatch: (() => void) | null = null;
  let content: HTMLElement | null = null;
  let page: IssuePage | null = null;
  const close = h("button", { class: "decide-close", attrs: { type: "button", "aria-label": "Close", "data-use": "backlog.close" }, on: { click: () => closeTallSheet() } }, svg(ICONS.back, "btn-icon"));
  // Painted again whenever Ops lands, so a sheet opened before the PRs were read gains its drafts.
  let painted = "";
  const paint = (data: BacklogResponse) => {
    const prs = (opsData.ops && freshPrs(opsData.ops)) ?? [];
    // A draft whose branch a chat has checked out has someone on it.
    const busy = new Set((app.workers?.workers ?? []).filter((w) => w.branch).map((w) => `${w.repo}#${w.branch}`));
    const backlog = backlogOf(repo, data, prs.filter((pr) => !(pr.branch && busy.has(`${pr.repo}#${pr.branch}`))));
    // Each repo's own reading: one GitHub could not read this pass keeps its last, and says how old it is.
    const reading = data.repos[repo];
    const age = !reading ? "GitHub list not read yet" : reading.stale ? `GitHub list from ${when(reading.at)}` : null;
    // Ops lands each minute: an unchanged sheet is left as it is, so a list opened with "N more" stays open.
    const painting = JSON.stringify([backlog, age]);
    if (painting === painted) return;
    painted = painting;
    sub.textContent = backlog.head;
    sub.hidden = !backlog.head;
    // Counts with no rows to show are the older issues: the foot opens them.
    const empty = backlog.head ? "None of the newest to show: the rest are on GitHub below" : "Nothing waiting";
    body.replaceChildren(
      ...(age ? [h("p", { class: "backlog-note" }, age)] : []),
      ...(backlog.sections.length ? backlog.sections.map((section) => sectionEl(section, openIssue)) : [h("p", { class: "backlog-note" }, empty)]),
    );
    foot.replaceChildren(...(backlog.foot ? [h("a", { class: "backlog-all", attrs: { href: backlog.foot.url, target: "_blank", rel: "noopener", "data-use": "backlog.all" } }, backlog.foot.label)] : []));
  };
  const head = h("header", { class: "home-sheet-head backlog-head" }, close, h("div", { class: "backlog-head-text" }, h("h2", { class: "home-sheet-title" }, projectName(repo)), sub));
  const load = () =>
    getBacklog()
      .then((data) => {
        if (!alive) return;
        read = data;
        paint(data);
        // Not under an open issue: the list comes back as it was left, its "N more" and scroll kept.
        unwatch ??= watchOps(() => alive && read && !page && paint(read));
      })
      .catch(() => {
        if (alive && !read) sub.textContent = "Could not read the list. Close and tap again.";
      });
  // The list stays as it is under the issue, and is read again when Start work or Close changed it.
  function openIssue(row: BacklogRow): void {
    if (!content || page || row.issue === null) return;
    page = openIssuePage(content, [head, body, foot], { repo, issue: row.issue, title: row.title, ...(row.start ? { start: row.start } : {}) }, (changed) => {
      page = null;
      if (changed) void load();
    });
  }
  openTallSheet(
    projectName(repo),
    {
      mount(el) {
        content = el;
        el.replaceChildren(head, body, foot);
        void load();
      },
      unmount: () => {
        alive = false;
        page?.leave();
        unwatch?.();
      },
    },
    { className: "home-sheet backlog-sheet", use: "desks.backlog", historyDepth: () => page?.depth() ?? 0 },
  );
}
