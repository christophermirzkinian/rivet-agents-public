import { rivetWords } from "../../src/shared/names.js";

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; attrs?: Record<string, string>; on?: Record<string, (event: Event) => void> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  for (const [name, value] of Object.entries(props.attrs ?? {})) element.setAttribute(name, value);
  for (const [name, handler] of Object.entries(props.on ?? {})) element.addEventListener(name, handler);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

/** `use` is the button's What you used id (src/shared/usage-ids.ts); `value` its 1-based position in a family. */
export function button(label: Child | Child[], onClick: () => void, variant = "", disabled = false, use = "", value?: number): HTMLButtonElement {
  const parts = Array.isArray(label) ? label : [label];
  const element = h("button", { class: `btn ${variant}`.trim(), attrs: { type: "button" }, on: { click: onClick } }, ...parts);
  element.disabled = disabled;
  if (use) element.dataset.use = use;
  if (value !== undefined) element.dataset.useValue = String(value);
  return element;
}

/** The element in full screen: the browser's, or an iPhone video in its own player. */
export function fullScreenElement(): Element | null {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return (
    document.fullscreenElement ??
    doc.webkitFullscreenElement ??
    [...document.querySelectorAll("video")].find((video) => (video as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen) ??
    null
  );
}

/** Full-screen change events: the standard one, Safari's prefixed one, and the iPhone video player's. */
export const FULL_SCREEN_EVENTS = ["fullscreenchange", "webkitfullscreenchange", "webkitbeginfullscreen", "webkitendfullscreen"];

/**
 * True while a dialog (a sheet, a worker's sheet, the screenshot viewer) or a full-screen video holds the keyboard;
 * page shortcuts wait.
 */
export function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null || fullScreenElement() !== null;
}

/**
 * Makes everything behind an open dialog inert, so neither focus nor a click
 * reaches it; the toasts stay live so a held answer can still be undone.
 * Returns the restore.
 */
export function inertBehind(dialog: Element): () => void {
  const made: Element[] = [];
  const walk = (parent: Element) => {
    for (const child of parent.children) {
      if (child === dialog || child.hasAttribute("inert") || child.classList.contains("toasts")) continue;
      if (child.querySelector(".toasts")) walk(child);
      else {
        child.setAttribute("inert", "");
        made.push(child);
      }
    }
  };
  walk(document.body);
  return () => {
    for (const element of made) element.removeAttribute("inert");
  };
}

/** Attributes that name a control, or what it sits in (a card and its revision, a list item), across a redraw. */
const IDS = ["data-need", "data-rev", "data-worker", "data-tab", "data-filter", "data-item", "data-chat", "data-id", "data-key", "data-pane", "data-attach", "data-reply", "href"];
function idsOf(el: Element): string {
  return IDS.filter((name) => el.hasAttribute(name))
    .map((name) => `${name}=${el.getAttribute(name)}`)
    .join(" ");
}
/**
 * A control's name: its own ids, else its words, and the ids of everything it sits in, so one card's Approve is never
 * another's and a card's new revision never inherits the old one's focus.
 */
function nameOf(el: Element, root: Element): string {
  // Words as shown (rivet-words.ts): the redrawn copy still has the old name until the page rewrites it.
  const parts = [idsOf(el) || rivetWords(`${el.textContent}|${el.getAttribute("aria-label") ?? ""}`)];
  for (let at = el.parentElement; at && at !== root; at = at.parentElement) parts.push(idsOf(at));
  return parts.join("/");
}

/**
 * Remembers the control the keyboard is on inside `root`; the returned call, after a redraw, puts the keyboard back
 * on that same control. Dropped to the page, Enter would answer the open card instead. Only the exact control counts,
 * since a look-alike may answer something else; when it is gone, `fallback` may name a control that answers nothing,
 * given the controls with the same class and where the old one stood among them.
 */
export function keepFocus(root: Element, fallback?: (was: HTMLElement, like: HTMLElement[], at: number) => HTMLElement | null | undefined): () => void {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === root || !root.contains(el)) return () => {};
  const like = () => [...root.querySelectorAll<HTMLElement>(el.tagName)].filter((c) => c.className === el.className);
  const at = like().indexOf(el);
  const name = nameOf(el, root);
  return () => {
    // Kept but moved (the phone's band is put back in a redrawn header), it lost the keyboard on the way out.
    if (el.isConnected) {
      if (document.activeElement !== el && root.contains(el)) el.focus({ preventScroll: true });
      return;
    }
    const same = like();
    // A control redrawn in another tone (its class changed) is still found by its whole name, its card and revision
    // included, so it never lands on a newer card's answer.
    const named = [...root.querySelectorAll<HTMLElement>(el.tagName)].filter((c) => nameOf(c, root) === name);
    const match = same.find((c) => nameOf(c, root) === name) ?? (named.length === 1 ? named[0] : undefined) ?? fallback?.(el, same, at);
    match?.focus({ preventScroll: true });
  };
}

/**
 * Hands the keyboard to `el` itself when the control holding it goes and nothing like it comes back: never to the page,
 * where Enter would confirm a card waiting for it. Card keys pass `el` by, and it is focusable only until the focus
 * leaves, so a later click inside it never holds them back.
 */
export function parkFocus(el: HTMLElement): void {
  const hadTab = el.hasAttribute("tabindex");
  const keys = el.dataset.cardKeys;
  if (!hadTab) el.tabIndex = -1;
  el.dataset.cardKeys = "off";
  el.addEventListener(
    "blur",
    () => {
      if (!hadTab) el.removeAttribute("tabindex");
      if (keys === undefined) delete el.dataset.cardKeys;
    },
    { once: true },
  );
  el.focus({ preventScroll: true });
}

/** Inline SVG from a fixed, trusted string (never board data). */
export function svg(markup: string, className = "icon"): HTMLElement {
  const holder = h("span", { class: className, attrs: { "aria-hidden": "true" } });
  holder.innerHTML = markup;
  return holder;
}

export function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// An https:// run that starts with a host, up to whitespace, a quote, an angle bracket, a backslash, a control
// character, or an invisible or direction-changing mark, so a link can never hide or reorder part of what it shows.
const URL_RUN = /https:\/\/(?![/\\])[^\s<>"'`\\\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/giu;
const MAX_LINK = 2048;

const OPENS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Drops the sentence's punctuation after a URL, and a closing bracket the URL did not open. `_` and `~` stay:
 * they end real paths and tokens. Brackets are counted once, so a long run of them costs linear time.
 */
function trimUrl(run: string): string {
  const count: Record<string, number> = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 };
  for (const char of run) if (char in count) count[char]! += 1;
  let end = run.length;
  while (end > 0) {
    const last = run[end - 1]!;
    const open = OPENS[last];
    if (/[.,;:!?*\u2019\u201d]/u.test(last)) end -= 1;
    else if (open !== undefined && count[last]! > count[open]!) {
      count[last]! -= 1;
      end -= 1;
    } else break;
  }
  return run.slice(0, end);
}

/**
 * Text with each https:// URL in it as a link that opens outside the app. Nothing but https is linked (no
 * javascript:, data:, http: or bare domains), nor a URL carrying a user name or password; everything is built
 * as nodes and text, never parsed as HTML.
 */
export function linkify(text: string): Child[] {
  const parts: Child[] = [];
  let from = 0;
  for (const match of text.matchAll(URL_RUN)) {
    const at = match.index;
    if (at > 0 && /[\p{L}\p{N}_]/u.test(text[at - 1] ?? "")) continue;
    const shown = trimUrl(match[0]);
    let url: URL | null = null;
    try {
      url = new URL(shown);
    } catch {}
    if (!url || url.protocol !== "https:" || !url.hostname || url.username || url.password || shown.length > MAX_LINK) continue;
    if (at > from) parts.push(text.slice(from, at));
    // Isolated left-to-right, so direction marks in the text around it cannot reverse what the link shows.
    // Rivet's own link (the morning line's `/?tab=what-you-used`) opens in the app's own window, so an installed app stays itself.
    const away: Record<string, string> = url.origin === location.origin ? {} : { target: "_blank", rel: "noopener noreferrer" };
    parts.push(h("a", { class: "text-link", attrs: { href: url.href, ...away, dir: "ltr", "data-use": "link.text" } }, shown));
    from = at + shown.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/** Just the links in `text`, for a place that shows the text inside a button, where a link cannot go. */
export function linksIn(text: string): HTMLAnchorElement[] {
  const links = linkify(text).filter((part): part is HTMLAnchorElement => part instanceof HTMLAnchorElement);
  // They sit inside a tagged control's own box, whose tag names a tap on them.
  for (const link of links) link.removeAttribute("data-use");
  return links;
}

export function describe(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Passkey request was cancelled.";
  return error instanceof Error ? error.message : "Something went wrong.";
}

export const ICONS = {
  yes: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  no: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>',
  later: '<svg viewBox="0 0 24 24"><path d="M12 19V6M6 11.5L12 5.5l6 6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M4.5 6.5a2 2 0 012-2h11a2 2 0 012 2v8a2 2 0 01-2 2H11l-4.5 3.5v-3.5a2 2 0 01-2-2z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M9 6.5h11M9 12h11M9 17.5h11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="4.5" cy="6.5" r="1.4" fill="currentColor"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor"/><circle cx="4.5" cy="17.5" r="1.4" fill="currentColor"/></svg>',
  cards: '<svg viewBox="0 0 24 24"><rect x="6" y="3.5" width="12" height="17" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M3 7v11M21 7v11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  mac: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M9 20h6M12 16v4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="M8.5 7l-5 5 5 5M15.5 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  hq: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="2.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="2.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="2.2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M10 20.5a2 2 0 004 0" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3.5v11M8 7.5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 11H5.5v9.5h13V11H17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>',
  progress: '<svg viewBox="0 0 24 24"><path d="M3.5 17.5l5.5-6 4 4 7.5-8.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="18.5" cy="12" r="2" fill="currentColor"/></svg>',
  usage: '<svg viewBox="0 0 24 24"><path d="M4 20h16M7 16.5V11M12 16.5V5.5M17 16.5V9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  costs: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M14.8 9.2c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2.1 0 2.9 5.8 1.5 5.8 4.3 0 1.3-1.3 2.1-3 2.1-1.3 0-2.4-.5-3-1.5M12 6v1.8M12 16.3V18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  goal: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M4 6.5h16M4 12h16M4 17.5h16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="9" cy="7" r="2.2" fill="var(--bg, #000)" stroke="currentColor" stroke-width="2.2"/><circle cx="15" cy="12" r="2.2" fill="var(--bg, #000)" stroke="currentColor" stroke-width="2.2"/><circle cx="8" cy="17" r="2.2" fill="var(--bg, #000)" stroke="currentColor" stroke-width="2.2"/></svg>',
  kanban: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="4.5" height="16" rx="1.5" fill="none" stroke="currentColor" stroke-width="2.2"/><rect x="9.75" y="4" width="4.5" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="2.2"/><rect x="16" y="4" width="4.5" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  team: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M3 19.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M15.5 4.9a3.2 3.2 0 010 6.2M17.5 14.3c2.1.6 3.5 2.6 3.5 5.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  square: '<svg viewBox="0 0 24 24"><path d="M3.5 5.5a2 2 0 012-2h9a2 2 0 012 2v5a2 2 0 01-2 2H9l-3.5 3v-3a2 2 0 01-2-2z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M19.5 9a1.5 1.5 0 011 1.4v5.1a2 2 0 01-2 2V20l-3.2-2.5H12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  photo:
    '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M4.5 17.5l5-4.5 3.5 3 2.5-2 4 3.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M19.5 14.5A8 8 0 019.5 4.5a8 8 0 1010 10z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>',
  factory:
    '<svg viewBox="0 0 24 24"><path d="M3.5 20.5V10l5 3v-3l5 3V4.5h5v16z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M7 17h2M12 17h2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  mind: '<svg viewBox="0 0 24 24"><path d="M7 7l5 5M17 6l-5 6M12 12l-5 6M12 12l6 5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="6" cy="6" r="2.2" fill="currentColor"/><circle cx="18" cy="5.5" r="2.2" fill="currentColor"/><circle cx="6" cy="18.5" r="2.2" fill="currentColor"/><circle cx="18.5" cy="17.5" r="2.2" fill="currentColor"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5L13.5 10.5M4.5 19.5l6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shrink: '<svg viewBox="0 0 24 24"><path d="M19.5 10H14V4.5M4.5 14H10v5.5M14 10l5.5-5.5M10 14l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5"fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  forward: '<svg viewBox="0 0 24 24"><path d="M9.5 5.5L16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M5 20.5c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
};
