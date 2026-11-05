import type { ComingItem } from "../../../src/shared/board.js";
import { opsStatusKey } from "../../../src/shared/ops-status-key.js";
import { maybeWhen, when } from "../../../src/shared/when.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import * as api from "../api.js";
import * as cmd from "../command-api.js";
import { button, describe, h } from "../dom.js";
import { refreshStatuses, watchStatuses } from "../ops-data.js";
import { app, signedOut, subscribe } from "../state.js";
import { comingRowRepo, shownComingRows } from "./board.js";
import { chatKey, chatRowRepo } from "./coming-filter.js";
import { cleanComing, comingBar, comingDone, comingName, comingQuietMs, comingWhat, prHref, quietText, type Repo, stageLabel } from "./queue-cards.js";
import { discussButton, discussPrefix, quoted } from "./discuss.js";
import { firstOutput, fixChatOf } from "./ops-status.js";
import { closeSheet, openSheet } from "./sheet.js";
import { paintWait, sending } from "./mac-wait.js";
import { flash } from "./toast.js";
import { RIVET_NAME, chatName } from "../../../src/shared/names.js";

// A Coming item's details: what it is, where it is, when it lands, its PR and its chat. One nobody has started yet can
// be started or dropped from here: the choice goes to Rivet as a chat message, the way you would type it. Start it is
// Ops' Fix it for a Coming item: Rivet runs `rivet fix coming <key>`, the sheet follows it from Opening… to the chat and its first output, and a
// live chat for the item makes it Open chat.

type Choice = "start" | "drop";

/** What you already sent from this sheet this session, by item, so reopening it says so instead of offering it again. */
const sent = new Map<string, Choice>();
/** Choices on their way, by item: a sheet reopened meanwhile waits for the same send instead of starting another. */
const pending = new Map<string, Choice>();
/** While a Start it is opening, the statuses load this often, so the sheet shows its chat soon after it opens. */
const OPENING_POLL_MS = 5_000;
/** The sheet on screen, which a send finishing after a close and reopen reports to. */
let live: { key: string; status: HTMLElement; start: HTMLButtonElement; drop: HTMLButtonElement; paint: () => void } | null = null;

const key = (item: ComingItem) => `${item.pr ?? ""}\n${item.app ?? ""}\n${item.title}`;
/** The sheet's own key: the item's, in its repo, so two repos' rows alike in PR, app and title never share one. */
const sheetKey = (item: ComingItem, repo: Repo | null | undefined) => `${repo === null ? `?${item.chat ?? ""}` : (repo ?? NO_REPO)}\n${key(item)}`;
/** One repo, however it is written: no repo is the default one's; two repos claiming a row (null) match only each other. */
const sameRepo = (a: Repo | null | undefined, b: Repo | null | undefined) => (a === null || b === null ? a === b : (a ?? NO_REPO).toLowerCase() === (b ?? NO_REPO).toLowerCase());

const itemName = (item: ComingItem) => (item.app && item.app !== item.title ? `${item.app}: ${item.title}` : item.title);
const itemRefs = (item: ComingItem) => [item.pr ? `PR #${item.pr}` : null, item.chat ? `chat ${item.chat}` : null];

/** The item's status key in its repo: its PR number, else its name. */
export const comingKey = (item: ComingItem, repo?: Repo | null) => opsStatusKey("coming", item.pr ? String(item.pr) : itemName(item), repo ?? NO_REPO);

/** Discuss this: the message starts by naming the item, its PR (and repo, when not this one) and chat. */
export function discussText(item: ComingItem, repo?: Repo | null): string {
  const pr = item.pr ? `PR #${item.pr}${repo && repo !== NO_REPO ? ` in ${repo}` : ""}` : null;
  return discussPrefix(itemName(item), "Coming", [pr, item.chat ? `chat ${item.chat}` : null]);
}

/** The message Rivet gets for a choice: your words, and the item's own text only as a quoted name. */
export function choiceText(item: ComingItem, choice: Choice, repo?: Repo | null): string {
  const where = itemRefs(item).filter(Boolean).join(", ");
  const name = itemName(item);
  if (choice === "start") {
    // rivet fix takes a title of up to 300 characters, and the repo the sheet found the item's chat in.
    const title = name.length > 300 ? `${name.slice(0, 299)}…` : name;
    const inRepo = repo && repo !== NO_REPO ? ` --repo ${repo}` : "";
    return `Start it (from Coming): run rivet fix coming ${comingKey(item, repo)}${inRepo} --title ${quoted(title)}${where ? ` (${where})` : ""}.`;
  }
  return `Drop it (from Coming), the item named ${quoted(name)}${where ? ` (${where})` : ""}. Please take this off Coming; I don't want it.`;
}

/** Sets the sheet on screen for `k`: a pending send holds both choices, a sent one stays pressed. */
function showState(k: string): void {
  if (live?.key !== k) return;
  const done = sent.get(k);
  live.drop.disabled = pending.has(k) || done === "drop";
  live.paint();
}



function fact(label: string, value: HTMLElement | string | null): HTMLElement | null {
  return value === null ? null : h("div", { class: "cs-fact" }, h("dt", {}, label), h("dd", {}, value));
}

function sentLine(choice: Choice): string {
  return choice === "start" ? `Opening a chat: asked ${RIVET_NAME}.` : `Sent to ${RIVET_NAME}: drop it.`;
}

/** `openChat` gets the repo of the board chat holding the item's PR, from the board as it is now. */
export function openComingSheet(raw: ComingItem, openChat: (name: string, repo?: Repo) => void, now = Date.now()): void {
  const item = cleanComing(raw);
  const repoNow = () => comingRowRepo(app.board?.board?.chats ?? [], item);
  const repo = repoNow();
  // Merged work is underway whatever stage it was typed at: never offered to start or drop.
  const started = Boolean(item.stage || item.mergedAt);
  const what = comingWhat(item);
  const quiet = quietText(comingQuietMs(item, now));
  const k = sheetKey(item, repo);
  const status = h("p", { class: "cs-status", attrs: { role: "status" } }, pending.has(k) ? (pending.get(k) === "start" ? "Opening…" : "Sending…") : sent.has(k) ? sentLine(sent.get(k)!) : "");
  const fixRepo = repo ?? NO_REPO;
  /** The item's chat, when one it can open: live, or named since this phone's Start it. */
  const fixChat = () => {
    const { chat, worker } = fixChatOf("coming", comingKey(item, fixRepo), fixRepo);
    return chat !== null && (worker !== null || sent.get(k) === "start") ? { chat, worker } : null;
  };
  const report = (text: string) => {
    if (live?.key === k) live.status.textContent = text;
  };

  const choose = (choice: Choice) => {
    if (pending.has(k) || sent.get(k) === choice) return;
    pending.set(k, choice);
    report(choice === "start" ? "Opening…" : "Sending…");
    showState(k);
    cmd.sendChat(choiceText(item, choice, repo), [], [], undefined, null).then(
      () => {
        pending.delete(k);
        sent.set(k, choice);
        report(sentLine(choice));
        showState(k);
        flash(choice === "start" ? `${RIVET_NAME} is opening a chat on it` : `${RIVET_NAME} will drop it`);
      },
      (error: unknown) => {
        pending.delete(k);
        showState(k);
        if (error instanceof api.ApiError && error.status === 401) return signedOut("Your session ended. Sign in again.");
        report(describe(error));
      },
    );
  };
  const start = sending(
    button(
      "Start it",
      () => {
        const open = fixChat();
        if (!open) return choose("start");
        closeSheet();
        openChat(open.chat, repo ?? undefined);
      },
      "primary",
      false,
      "coming.sheet.start",
    ),
  );
  const drop = sending(button("Drop it", () => choose("drop"), "ghost", false, "coming.sheet.drop"));
  let poll = 0;
  const nobody = h("span", {}, "Nobody has it yet");
  /** Start it as the fix opens: Opening… until the item's status names a chat, then Open chat and its first output. */
  const paint = () => {
    const open = fixChat();
    const opening = !open && (pending.get(k) === "start" || sent.get(k) === "start");
    const label = open ? "Open chat" : opening ? "Opening…" : "Start it";
    if (start.firstChild?.textContent !== label) {
      start.firstChild?.remove();
      start.prepend(label);
    }
    start.disabled = opening;
    paintWait(start);
    nobody.textContent = open ? chatName(open.chat) : "Nobody has it yet";
    if (open) report(`Chat open: ${chatName(open.chat)}. ${open.worker ? firstOutput(open.worker) : "Waiting for its first output"}`);
    window.clearTimeout(poll);
    if (opening && sent.get(k) === "start") poll = window.setTimeout(refreshStatuses, OPENING_POLL_MS);
  };
  live = { key: k, status, start, drop, paint };
  // A started row offers its fix chat once one is open: the sheet redraws when that changes.
  const hadFix = Boolean(fixChat());
  const fixMoved = () => started && Boolean(fixChat()) !== hadFix;
  showState(k);

  const body = h(
    "div",
    { class: `cs${started ? "" : " cs-new"}`, attrs: { "data-stage": item.stage ?? "none" } },
    item.app ? h("p", { class: "cs-title" }, item.title) : null,
    what && what !== item.title ? h("p", { class: "cs-what" }, what) : null,
    h(
      "div",
      { class: "cs-where" },
      h("span", { class: `cs-stage${item.mergedAt ? " s-merged" : item.stage ? ` s-${item.stage}` : ""}` }, stageLabel(item) ?? "Not started"),
      item.progress !== undefined && !comingDone(item) ? h("span", { class: "cs-pct" }, `${Math.round(item.progress * 100)}%`) : null,
      quiet ? h("span", { class: "cs-quiet" }, quiet) : null,
    ),
    comingBar(item),
    h(
      "dl",
      { class: "cs-facts" },
      fact("Requested", maybeWhen(item.requestedAt)),
      fact("Updated", maybeWhen(item.touchedAt ?? item.updatedAt)),
      fact(
        "PR",
        !item.pr
          ? null
          : repo === null || !(repo ?? NO_REPO)
            ? `#${item.pr}`
            : h("a", { class: "cs-pr", attrs: { href: prHref(item.pr, repo), target: "_blank", rel: "noopener noreferrer", "data-use": "coming.sheet.pr" } }, `#${item.pr} on GitHub`),
      ),
      fact("Chat", item.chat ? (repo === null ? `${chatName(item.chat)}, in more than one repo` : chatName(item.chat)) : started ? null : nobody),
    ),
    // A fix chat Start it opened says more than "not started" until the Coming row catches up.
    started || fixChat() ? null : h("p", { class: "cs-hint" }, `Not started yet. Tell ${RIVET_NAME} what to do with it.`),
    h(
      "div",
      { class: "cs-actions" },
      item.chat && repo !== null
        ? button(
            "Open chat",
            () => {
              closeSheet();
              openChat(item.chat!, repo ?? undefined);
            },
            started ? "primary" : "",
            false,
            "coming.sheet.chat",
          )
        : // Work under way whose row names no chat yet still opens the fix chat Start it opened.
          started && fixChat()
          ? button(
              "Open chat",
              () => {
                const open = fixChat();
                if (!open) return;
                closeSheet();
                openChat(open.chat, fixRepo);
              },
              "primary",
              false,
              "coming.sheet.chat",
            )
          : null,
      started ? null : start,
      started ? null : drop,
    ),
    // What each choice does next, as the card sheet's Reject says it.
    started
      ? null
      : h(
          "ul",
          { class: "cs-next" },
          h("li", {}, h("strong", {}, "Start it: "), "opens a chat on it. Nothing merges or deploys from this button."),
          h("li", {}, h("strong", {}, "Drop it: "), `goes to ${RIVET_NAME}, who takes it off Coming. Nothing is built.`),
        ),
    status,
  );
  // A board update that changes the item repaints the sheet, so it never offers Start it or Drop it for work underway
  // and Open chat always opens the chat it has now, in the repo the board gives that chat now.
  let unwatch: (() => void) | null = null;
  let unwatchFix: (() => void) | null = null;
  openSheet(
    comingName(item),
    {
      mount: (el) => {
        el.append(body);
        unwatch = subscribe(() => {
          // The Mac can come and go while the sheet is open: Start it and Drop it say whether they wait for it.
          paintWait(start);
          paintWait(drop);
          // Coming as the Feed shows it: a row made from a chat at work is that chat's while it works, whatever it says it does.
          // The row that chat holds now goes on in the sheet: a posted row for it takes the made row's place.
          const own = chatRowRepo(item);
          const shown = shownComingRows(app.board?.board);
          // Only a row of that very name: a numbered one would open a chat of that number, not this one.
          const held = own && item.chat ? shown.heldBy.get(chatKey(own, item.chat)) : undefined;
          if (held && held.chat !== item.chat) {
            closeSheet();
            return;
          }
          // A posted row's sheet goes on with posted rows only, as before rows were made from chats; two can share a
          // title, so the one naming this sheet's chat first, and the sheet never jumps to another chat's.
          const rows = shown.rows.filter((other) => !chatRowRepo(other)).map(cleanComing);
          // Another chat's row alike in PR, app and title takes the sheet only in the sheet's repo.
          const chats = app.board?.board?.chats ?? [];
          const now = own
            ? held && cleanComing(held)
            : (rows.find((other) => key(other) === key(item) && other.chat === item.chat) ?? rows.find((other) => key(other) === key(item) && sameRepo(comingRowRepo(chats, other), repo)));
          if (!now) closeSheet();
          else if (JSON.stringify(now) !== JSON.stringify(item) || !sameRepo(repoNow(), repo) || fixMoved()) openComingSheet(now, openChat);
          else if (live?.key === k) paint();
        });
        unwatchFix = watchStatuses(() => {
          if (live?.key !== k) return;
          if (fixMoved()) openComingSheet(raw, openChat);
          else if (!started) paint();
        });
      },
      unmount: () => {
        unwatch?.();
        unwatchFix?.();
        window.clearTimeout(poll);
      },
    },
    "Close",
    discussButton(discussText(item, repo)),
    { use: "coming.sheet", closeUse: "coming.sheet.close" },
  );
}

/** Forgets what was sent (tests). */
export function resetComingSheet(): void {
  sent.clear();
  pending.clear();
  live = null;
}
