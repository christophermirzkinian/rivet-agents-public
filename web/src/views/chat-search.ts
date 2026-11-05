import { MIN_QUERY, type SearchItem } from "../../../src/shared/search.js";
import * as cmd from "../command-api.js";
import { maybeWhen } from "../../../src/shared/when.js";
import { h, svg } from "../dom.js";

// Chat's own search: one bar over conversation titles and message text, from /api/chat/search.
// A hit opens its conversation at that message. The bar is made once per mount, so a redraw of the list never takes
// the caret or the results away.

const DEBOUNCE_MS = 180;
const CLEAR =
  '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

export interface ChatSearch {
  el: HTMLElement;
  /** True while a query is typed: the results stand in for the list or the conversation. */
  active(): boolean;
  /** Empties the bar; `quiet` leaves the redraw to the caller, which is about to show something else. */
  clear(quiet?: boolean): void;
}

/**
 * `open` takes the id of the message hit, or of a conversation's first message with `whole` set (a title hit opens on
 * the newest, not at its first message); `changed` runs as results show or go.
 */
export function chatSearch(open: (id: string, whole: boolean) => void, changed: () => void): ChatSearch {
  const input = h("input", {
    class: "chat-search-input",
    attrs: { type: "search", placeholder: "Search every topic", "aria-label": "Search conversations and messages", autocomplete: "off", enterkeyhint: "search" },
  });
  const clearBtn = h(
    "button",
    { class: "icon-btn chat-search-clear", attrs: { type: "button", "aria-label": "Clear search", "data-use": "chat.search.clear" }, on: { click: () => (clear(), input.focus()) } },
    svg(CLEAR, "icon-btn-icon"),
  );
  const status = h("p", { class: "chat-search-status", attrs: { role: "status" } });
  const list = h("ul", { class: "chat-search-results", attrs: { "aria-label": "Search results" } });
  const results = h("div", { class: "chat-search-body" }, status, list);
  const el = h("div", { class: "chat-search", attrs: { role: "search" } }, h("div", { class: "chat-search-field" }, input, clearBtn), results);
  let timer = 0;
  let generation = 0;
  let was = false;

  const active = () => input.value.trim().length > 0;
  const paint = () => {
    const now = active();
    clearBtn.hidden = !input.value;
    results.hidden = !now;
    if (now !== was) {
      was = now;
      changed();
    }
  };
  const show = (hits: SearchItem[], text: string) => {
    list.replaceChildren(
      ...hits.map((hit) =>
        h(
          "li",
          {},
          h(
            "button",
            {
              class: `chat-search-hit${hit.key.startsWith("conversation:") ? " is-conversation" : ""}`,
              attrs: { type: "button", "data-open": hit.open.type === "message" ? hit.open.id : "", "data-use": "chat.search.hit" },
              on: { click: () => pick(hit) },
            },
            h("span", { class: "chat-search-title" }, hit.title),
            h("span", { class: "chat-search-detail" }, [hit.detail, maybeWhen(hit.at)].filter(Boolean).join(" · ")),
          ),
        ),
      ),
    );
    status.textContent = text;
  };
  const run = async () => {
    const query = input.value.trim();
    const mine = ++generation;
    if (query.length < MIN_QUERY) return show([], query ? `Type ${MIN_QUERY} or more letters.` : "");
    show([], "Searching…");
    const hits = await cmd.searchChat(query).then(
      (response) => response.results,
      () => null,
    );
    if (mine !== generation) return;
    if (!hits) return show([], "Couldn't search. Try again.");
    show(hits, hits.length ? "" : "No matches.");
  };
  function pick(hit: SearchItem): void {
    if (hit.open.type !== "message") return;
    const id = hit.open.id;
    // `open` redraws: the conversation it shows, not first the one the results stood over.
    clear(true);
    open(id, hit.key.startsWith("conversation:"));
  }
  function clear(quiet = false): void {
    if (!input.value && !timer) return;
    window.clearTimeout(timer);
    timer = 0;
    generation += 1;
    input.value = "";
    show([], "");
    if (quiet) was = false;
    paint();
  }
  input.addEventListener("input", () => {
    // An answer to what was typed before never shows under this.
    generation += 1;
    paint();
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && input.value) {
      event.preventDefault();
      clear();
    }
  });
  paint();
  return { el, active, clear };
}
