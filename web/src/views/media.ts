import "./media.css";

import { answerText } from "../../../src/shared/conversations.js";
import type { MediaItem, MediaPage } from "../../../src/shared/media.js";
import { clock, dayDate } from "../../../src/shared/when.js";
import { localDay } from "../day.js";
import { ApiError, call } from "../api.js";
import { describe, h, svg } from "../dom.js";
import { onSessionReset } from "../session.js";
import { app, changed, navStamp, refresh as refreshBoard, sameSession, signedOut } from "../state.js";
import { fetchDocument } from "./documents.js";
import * as feed from "./feed.js";
import { leaveOverlays } from "./navigation.js";
import { openImages, openVideo, type LightboxAction } from "./lightbox.js";
import { discussButton, discussPrefix } from "./discuss.js";
import { openSheet } from "./sheet.js";

// The Media tab: every photo and video Rivet sent him, on a card or in the chat, newest first and
// grouped by local day, so a picture is still there after its card is answered or dropped. A tap shows it full size,
// with a way back to its card or its conversation.

const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';

export const mediaApi = {
  get: (before: string | null) => call<MediaPage>("GET", `/api/media${before ? `?before=${encodeURIComponent(before)}` : ""}`),
};

/** One card's or one chat message's pictures and clips, newest first. */
export interface MediaEntry {
  key: string;
  at: string;
  items: MediaItem[];
}

let root: HTMLElement | null = null;
let items: MediaItem[] = [];
let next: string | null = null;
let loaded = false;
let loading = false;
let error: string | null = null;
/** Bumped by a fresh load, so a page that comes after it is dropped. */
let ticket = 0;
onSessionReset(() => {
  items = [];
  next = null;
  loaded = false;
  loading = false;
  error = null;
});

export function mount(el: HTMLElement): void {
  root = el;
  render();
  void load(false);
}

export function unmount(): void {
  root = null;
}

export function refresh(): Promise<void> {
  return load(false);
}

async function load(more: boolean): Promise<void> {
  const mine = more ? ticket : ++ticket;
  const current = sameSession();
  loading = true;
  render();
  try {
    const page = await mediaApi.get(more ? next : null);
    if (mine !== ticket || !current()) return;
    items = more ? [...items, ...page.items] : page.items;
    next = page.next;
    loaded = true;
    error = null;
  } catch (failure) {
    if (mine !== ticket || !current()) return;
    if (failure instanceof ApiError && failure.status === 401) {
      signedOut("Your session ended. Sign in again.");
      return;
    }
    error = describe(failure);
  } finally {
    if (mine === ticket) loading = false;
  }
  render();
}

/** The items as entries, one per card or chat message (each file of an earlier card alone), each where its newest item is. */
export function entries(list: readonly MediaItem[]): MediaEntry[] {
  const byKey = new Map<string, MediaEntry>();
  for (const item of list) {
    const key = item.card ? `card:${item.card.id}` : item.chat ? `chat:${item.chat.message}` : `earlier:${item.sha}`;
    const entry = byKey.get(key);
    if (entry) entry.items.push(item);
    else byKey.set(key, { key, at: item.at, items: [item] });
  }
  return [...byKey.values()];
}

// Times, in the phone's own zone

const dayNumber = (t: number) => Date.parse(`${localDay(t)}T00:00:00Z`) / 86_400_000;

/** "Today", "Yesterday", else "Thu 2 Oct" (with the year when it is not this one), by the phone's calendar. */
export function dayLabel(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  const days = dayNumber(now) - dayNumber(t);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return dayDate(t, now);
}

/** "2:14pm" in the phone's own zone. */
export function clockLabel(iso: string): string {
  return clock(iso);
}

// The list

function render(): void {
  if (!root) return;
  const body: HTMLElement[] = [];
  if (error) body.push(h("p", { class: "media-tab-note", attrs: { role: "alert" } }, `Could not load Media: ${error}`));
  if (!loaded && !error) body.push(h("p", { class: "media-tab-note" }, "Loading…"));
  else if (loaded && items.length === 0) body.push(h("p", { class: "media-tab-note" }, "No photos or videos yet."));
  let day = "";
  let group: HTMLElement | null = null;
  for (const entry of entries(items)) {
    const label = dayLabel(entry.at);
    if (label !== day || !group) {
      day = label;
      group = h("section", { class: "media-tab-day", attrs: { "aria-label": label } }, h("h2", { class: "media-tab-day-title" }, label));
      body.push(group);
    }
    group.append(entryView(entry));
  }
  if (next) {
    body.push(
      h(
        "button",
        { class: "btn media-tab-more", attrs: { type: "button", "data-use": "media.more", ...(loading ? { "aria-busy": "true" } : {}) }, on: { click: () => !loading && void load(true) } },
        loading ? "Loading…" : "More",
      ),
    );
  }
  root.replaceChildren(h("div", { class: "media-tab" }, ...body));
}

const sourceWord = (item: MediaItem) => (item.source === "card" ? "Card" : "Chat");

function entryView(entry: MediaEntry): HTMLElement {
  const first = entry.items[0]!;
  // The line under the pictures opens where they came from: the card (Open card) or the chat message.
  const action = sourceAction(first);
  return h(
    "article",
    { class: "media-tab-entry", attrs: { "data-key": entry.key } },
    h("div", { class: "media-tab-thumbs" }, ...entry.items.map((item, i) => thumb(entry, item, i))),
    h(
      action ? "button" : "p",
      { class: action ? "media-tab-source media-tab-open" : "media-tab-source", attrs: action ? { type: "button", "aria-label": `${action.label}: ${first.title}`, "data-use": "media.open" } : {}, ...(action ? { on: { click: action.run } } : {}) },
      h("span", { class: `media-tab-kind from-${first.source}` }, sourceWord(first)),
      h("span", { class: "media-tab-title" }, first.title),
      h("time", { class: "media-tab-time", attrs: { datetime: entry.at } }, clockLabel(entry.at)),
    ),
  );
}

const isVideo = (item: MediaItem) => item.type.startsWith("video/");
const src = (sha: string) => `/media/${sha}`;

function thumb(entry: MediaEntry, item: MediaItem, index: number): HTMLElement {
  const video = isVideo(item);
  const noun = video ? "Video" : "Photo";
  const count = entry.items.length > 1 ? ` ${index + 1} of ${entry.items.length}` : "";
  const picture = !video
    ? h("img", { class: "media-tab-thumb-img", attrs: { src: src(item.sha), alt: "", loading: "lazy", decoding: "async" } })
    : item.poster
      ? h("img", { class: "media-tab-thumb-img", attrs: { src: src(item.poster), alt: "", loading: "lazy", decoding: "async" } })
      : h("video", { class: "media-tab-thumb-img", attrs: { src: `${src(item.sha)}#t=0.1`, preload: "metadata", muted: "", playsinline: "", "aria-hidden": "true" } });
  return h(
    "button",
    { class: "media-tab-thumb", attrs: { type: "button", "aria-label": `${noun}${count}: ${item.title}`, "data-use": "media.thumb" }, on: { click: () => view(entry, item) } },
    picture,
    video ? svg(PLAY, "media-tab-play") : null,
  );
}

// Full size

function fileName(item: MediaItem, index: number): string {
  const slug = item.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  const extension = { "image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4", "video/webm": "webm" }[item.type];
  return `${slug || "rivet"}-${index + 1}.${extension}`;
}

/** The photos of an entry in the image viewer, from the one tapped; a clip in the video viewer. */
function view(entry: MediaEntry, item: MediaItem): void {
  const action = sourceAction(item);
  const label = item.title;
  if (isVideo(item)) {
    openVideo(src(item.sha), item.poster ? src(item.poster) : undefined, label, (signal) => fetchDocument(src(item.sha), fileName(item, 0), item.type, signal), action);
    return;
  }
  const photos = entry.items.filter((one) => !isVideo(one));
  openImages(
    photos.map((one) => src(one.sha)),
    photos.indexOf(item),
    label,
    (i, signal) => fetchDocument(src(photos[i]!.sha), fileName(photos[i]!, i), photos[i]!.type, signal),
    action,
  );
}

/**
 * Open card: the card itself while it is on the board, else what it asked and the owner's answer. Open chat: the message.
 * None for a file from a card shown before the record, as which card it was is not known.
 */
/** Bumped by every Open card, so only the latest one's board read opens anything. */
let opening = 0;

export function sourceAction(item: MediaItem): LightboxAction | undefined {
  if (item.chat) {
    const { message } = item.chat;
    return {
      label: "Open chat",
      run: () => leaveOverlays(() => {
        app.chatFocus = message;
        app.tab = "chat";
        changed();
      }),
    };
  }
  const card = item.card;
  if (!card) return undefined;
  return {
    label: "Open card",
    run: () => leaveOverlays(() => {
      const mine = ++opening;
      const onBoard = () => Boolean(app.board?.board?.needs.some((need) => need.id === card.id));
      const answered = () =>
        openSheet(
          item.title,
          { mount: (el) => el.replaceChildren(...answerLines(item)), unmount: () => {} },
          "Close",
          discussButton(discussPrefix(item.title, "card", [`id ${card.id}`])),
          {},
        );
      if (onBoard()) feed.showCard(card.id);
      // Media can know of a card before this app's board does (a card added since its last read): read it, then go.
      // Nothing opens once the owner has moved on or opened another source meanwhile, or the read failed (signed out, offline).
      else if (card.onBoard) {
        const stamp = navStamp();
        void refreshBoard().then((ok) => {
          if (!ok || navStamp() !== stamp || mine !== opening) return;
          if (onBoard()) feed.showCard(card.id);
          else answered();
        });
      }
      else answered();
    }),
  };
}

function answerLines(item: MediaItem): HTMLElement[] {
  const { ask, answer } = item.card!;
  const lines: HTMLElement[] = [];
  if (ask) lines.push(h("p", { class: "media-tab-ask" }, ask));
  if (answer) {
    lines.push(
      h("p", { class: "media-tab-answer" }, answerText({ ...answer, itemTitle: item.title })),
      h("p", { class: "media-tab-answered" }, `You answered ${dayLabel(answer.at).replace(/^Today$/, "today").replace(/^Yesterday$/, "yesterday")} at ${clockLabel(answer.at)}.`),
    );
  } else lines.push(h("p", { class: "media-tab-answer" }, "This card has left the board. No answer from you is on record."));
  return lines;
}
