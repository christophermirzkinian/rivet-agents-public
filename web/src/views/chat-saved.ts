import "./chat-saved.css";

import { quoteText, type ChatMessage, type SavedLine } from "../../../src/shared/command.js";
import { RIVET_NAME } from "../../../src/shared/names.js";
import { maybeWhen } from "../../../src/shared/when.js";
import { ApiError } from "../api.js";
import * as cmd from "../command-api.js";
import { button, describe, h, linkify, svg } from "../dom.js";
import { closeSheet, openSheet } from "./sheet.js";
import { flash } from "./toast.js";

export const BOOKMARK =
  '<svg viewBox="0 0 24 24"><path d="M7 4.5h10v15.5l-5-3.8-5 3.8z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';
export const BOOKMARKED =
  '<svg viewBox="0 0 24 24"><path d="M7 4.5h10v15.5l-5-3.8-5 3.8z" fill="currentColor" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';
const CROSS =
  '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

export const SAVED_EMPTY = "Nothing saved yet. Tap Save on a message to keep it here.";

export interface ChatSaved {
  /** The head's bookmark button, which opens the list. */
  button: HTMLElement;
  /** The list, laid over Chat's lines while it is open. */
  el: HTMLElement;
  has(id: string): boolean;
  /** Saves a line, or unsaves it when it is saved. */
  toggle(message: ChatMessage): void;
  /** The saved ids the stream says the server holds now, from this device or another. */
  heard(ids: readonly string[]): void;
  load(): void;
  isOpen(): boolean;
  close(refocus: boolean, quiet?: boolean): void;
}

/**
 * Saved lines: a bookmark button, a Saved mark on the line, and a list where each one has a button to go to the
 * message, a button to reply to it, and a cross at its top right that asks before it removes it. Kept on the server, so
 * every device has the same list; `changed` redraws Chat's marks.
 */
export function chatSaved(opts: {
  go(line: SavedLine): void;
  reply(line: SavedLine): void;
  /** Whether the line offers Reply, as it does in Chat. */
  replies(line: SavedLine): boolean;
  /** The marks changed, or the list opened or closed (it covers Chat's lines while open). */
  changed(): void;
  /** The list is opening: search, which it would cover, goes. */
  opening(): void;
  signedOut(): void;
}): ChatSaved {
  let ids = new Set<string>();
  let lines: SavedLine[] | null = null;
  let failed = false;
  let open = false;
  let ticket = 0;
  /** Saves and unsaves still on their way, the newest per line: whatever list is heard meanwhile is read under them. */
  const pending = new Map<string, { want: boolean; n: number }>();
  let taps = 0;
  /** Bumped by every read asked for, every list the stream brings and every tap: only the newest sets the marks. */
  let heardAt = 0;

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) opts.signedOut();
    else flash(describe(error), "error");
  };

  const openBtn = h(
    "button",
    {
      class: "icon-btn chat-options chat-saved-open",
      attrs: { type: "button", "aria-label": "Saved messages", "aria-expanded": "false", "data-use": "chat.saved.open" },
      on: { click: () => (open ? close(true) : show()) },
    },
    svg(BOOKMARK, "icon-btn-icon"),
  );
  const closeBtn = button("Close", () => close(true), "chat-saved-close", false, "chat.saved.close");
  const list = h("div", { class: "chat-saved-list" });
  const el = h(
    "div",
    { class: "chat-saved", attrs: { role: "region", "aria-label": "Saved messages" } },
    h("div", { class: "chat-saved-head" }, h("h2", { class: "chat-saved-title" }, svg(BOOKMARKED, "chat-saved-mark"), "Saved"), closeBtn),
    list,
  );
  el.hidden = true;
  // The sheet Chat sits in closes on an Escape that reaches the page: while the list is open, Escape only puts it away.
  const onKey = (event: KeyboardEvent) => {
    if (!el.isConnected) {
      document.removeEventListener("keydown", onKey, true);
      return;
    }
    if (event.key !== "Escape" || document.querySelector(".lightbox")) return;
    // A sheet over the list (Remove from saved?) takes its own Escape.
    if ([...document.querySelectorAll('[aria-modal="true"]')].some((one) => !one.contains(el))) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  /** The saved ids heard from the server, with the taps still on their way laid over them. */
  function apply(server: Iterable<string>): void {
    ids = new Set(server);
    for (const [id, { want }] of pending) {
      if (want) ids.add(id);
      else ids.delete(id);
    }
    if (lines) lines = lines.filter((line) => ids.has(line.id));
  }

  /** The keyboard back on a redrawn item: the same control of the same line, else the × now in its place, else Close. */
  function focusNear(id: string, index: number, use = "chat.saved.remove"): void {
    const items = [...list.querySelectorAll<HTMLElement>(".chat-saved-item")];
    const same = items.find((one) => one.dataset.id === id);
    const target = same
      ? (same.querySelector<HTMLElement>(`[data-use="${use}"]`) ?? same.querySelector<HTMLElement>(".chat-saved-remove"))
      : items[Math.min(index, items.length - 1)]?.querySelector<HTMLElement>(".chat-saved-remove");
    (target ?? closeBtn).focus();
  }

  function draw(): void {
    if (!open) return;
    const at = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null;
    const was = at?.closest<HTMLElement>(".chat-saved-item");
    const back = at && was ? { id: was.dataset.id ?? "", index: [...list.children].indexOf(was), use: at.dataset.use } : null;
    paint();
    if (back && !list.contains(document.activeElement)) focusNear(back.id, back.index, back.use);
  }

  function paint(): void {
    if (!lines) {
      list.replaceChildren(h("p", { class: "chat-saved-empty", attrs: { role: "status" } }, failed ? "Saved messages didn't load." : "Loading…"));
      return;
    }
    if (!lines.length) {
      list.replaceChildren(h("p", { class: "chat-saved-empty" }, SAVED_EMPTY));
      return;
    }
    list.replaceChildren(...lines.map(item));
  }

  function item(line: SavedLine): HTMLElement {
    const remove = h(
      "button",
      {
        class: "chat-saved-remove",
        attrs: { type: "button", "aria-label": "Remove from saved", "data-use": "chat.saved.remove" },
        on: { click: () => confirmRemove(line) },
      },
      svg(CROSS, "chat-saved-cross"),
    );
    const said = maybeWhen(line.at);
    // A photo, file or card with no words shows as its quote does.
    const words = line.text || quoteText(line) || line.posted?.title || "";
    return h(
      "article",
      { class: "chat-saved-item", attrs: { "data-id": line.id } },
      h("p", { class: "chat-saved-who" }, `${line.from === "owner" ? "You" : RIVET_NAME}${said ? ` · ${said}` : ""}`),
      words ? h("p", { class: "chat-saved-text" }, ...linkify(words)) : null,
      h(
        "div",
        { class: "chat-saved-tools" },
        button("Go to message", () => {
          // Quietly: the way in redraws Chat once the line is up, so nothing the list covered is read on the way.
          close(false, true);
          opts.go(line);
        }, "primary", false, "chat.saved.go"),
        opts.replies(line)
          ? button("Reply", () => {
              close(false);
              opts.reply(line);
            }, "", false, "chat.saved.reply")
          : null,
      ),
      remove,
    );
  }

  function confirmRemove(line: SavedLine): void {
    // Where it stood: the list may redraw under the sheet, so its × (or, once removed, the next one) is found again.
    const index = lines?.findIndex((one) => one.id === line.id) ?? 0;
    openSheet(
      "Remove from saved?",
      {
        mount: (body) => body.replaceChildren(h("p", { class: "sheet-hint" }, "Only the bookmark goes. The message stays in Chat like any other.")),
        // The sheet gives back the page after this runs: the keyboard goes back once it has.
        unmount: () =>
          window.setTimeout(() => {
            if (open) focusNear(line.id, index);
          }),
      },
      "Cancel",
      button("Remove", () => {
        closeSheet();
        mark(line.id, false);
      }, "danger", false, "chat.saved.remove-confirm"),
      { cancelFirst: true, use: "chat.saved.confirm", closeUse: "chat.saved.remove-cancel" },
    );
  }

  /** Saves or unsaves at once; a refusal puts the line back as it was, in the list too. */
  function mark(id: string, want: boolean): void {
    const n = ++taps;
    heardAt++;
    pending.set(id, { want, n });
    const at = lines?.findIndex((line) => line.id === id) ?? -1;
    const was = at >= 0 ? lines![at]! : null;
    if (want) ids.add(id);
    else {
      ids.delete(id);
      if (lines) lines = lines.filter((line) => line.id !== id);
    }
    draw();
    opts.changed();
    (want ? cmd.saveLine(id) : cmd.unsaveLine(id)).then(
      () => {
        if (pending.get(id)?.n === n) pending.delete(id);
      },
      (error: unknown) => {
        if (pending.get(id)?.n !== n) return;
        pending.delete(id);
        if (want) ids.delete(id);
        else {
          ids.add(id);
          if (lines && was && !lines.some((line) => line.id === id)) lines.splice(Math.min(at, lines.length), 0, was);
        }
        draw();
        opts.changed();
        fail(error);
      },
    );
  }

  /** Reads the list and its marks; `quiet` (a reconnect or a poll's read) shows a failure in the list, never a toast. */
  function reload(quiet = false): void {
    const mine = ++ticket;
    const asked = ++heardAt;
    cmd.getSaved().then(
      ({ saved }) => {
        // A tap or a stream list since it was asked for knows better which are saved.
        const fresh = asked === heardAt;
        // Chat's marks take the read even when the list has closed since.
        if (fresh) apply(saved.map((line) => line.id));
        if (mine !== ticket) {
          if (fresh) opts.changed();
          return;
        }
        failed = false;
        lines = fresh ? saved : saved.filter((line) => ids.has(line.id));
        draw();
        opts.changed();
      },
      (error: unknown) => {
        if (mine !== ticket) return;
        failed = true;
        draw();
        if (!quiet) fail(error);
      },
    );
  }

  function show(): void {
    opts.opening();
    open = true;
    lines = null;
    failed = false;
    el.hidden = false;
    openBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onKey, true);
    draw();
    // Chat takes where it was before the list hides its lines, as it does for search.
    opts.changed();
    closeBtn.focus();
    reload();
  }

  /** `quiet` leaves Chat's redraw to the caller, as a way into a line does: a redraw now would read what the list covered. */
  function close(refocus: boolean, quiet = false): void {
    if (!open) return;
    open = false;
    ticket++;
    el.hidden = true;
    openBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey, true);
    if (!quiet) opts.changed();
    if (refocus) openBtn.focus();
  }

  return {
    button: openBtn,
    el,
    has: (id) => ids.has(id),
    toggle: (message) => mark(message.id, !ids.has(message.id)),
    heard(next) {
      heardAt++;
      apply(next);
      draw();
      opts.changed();
      if (open) reload();
    },
    load() {
      // An open list reads itself again, its marks with it: lines saved while the stream was down join it.
      if (open) return reload(true);
      const asked = ++heardAt;
      cmd.getSaved().then(
        ({ saved }) => {
          if (asked !== heardAt) return;
          apply((saved ?? []).map((line) => line.id));
          opts.changed();
        },
        // Chat works without its marks; the list asks again when it opens.
        () => {},
      );
    },
    isOpen: () => open,
    close,
  };
}
