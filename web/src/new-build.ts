// An installed app a phone kept suspended can wake on the build it loaded days ago. Back on screen after AWAY_MS
// hidden, it reads the app shell again and reloads when the shell names another main script, unless a reload would
// lose something that lives only in the page: text typed and unsent, or a photo or file picked and unsent. The chat
// box's draft is saved as it is typed and is back in the box after the reload, so it holds no reload up (a-12: a
// draft left in the box would keep a phone on a days-old build, without the fixes shipped since).

import { MAX_CHAT_TEXT } from "../../src/shared/command.js";
import { chatSendOut } from "./command-api.js";

export const AWAY_MS = 5 * 60_000;

/** The src of the shell's module script: the build's hashed entry. */
export function mainScript(html: string): string | null {
  for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
    if (!/\btype="module"/.test(tag)) continue;
    const src = /\bsrc="([^"]+)"/.exec(tag)?.[1];
    if (src) return src;
  }
  return null;
}

/** Chat's message box, and where views/chat.ts keeps its words (DRAFT_KEY and DRAFT_LONG_KEY there). */
const CHAT_BOX = "textarea.chat-text";
const CHAT_DRAFT_KEY = "rivet.chat.draft";
const CHAT_DRAFT_LONG_KEY = "rivet.chat.draft.long";
/**
 * A photo or file picked and not yet sent (views/attach.ts): the page alone holds it. One that failed cannot be sent
 * and is picked again either way, so it holds nothing.
 */
const PICKED = ".attach-strip > :not(.failed), .attach-docs > :not(.failed)";

type Kept = Pick<Storage, "getItem">;

/** The words a reload puts back in Chat's box, as chat.ts reads them (readDraft): capped unless kept whole. */
function savedDraft(storage: Kept | null): string | null {
  try {
    const draft = storage?.getItem(CHAT_DRAFT_KEY) ?? null;
    if (!storage || draft === null) return null;
    return storage.getItem(CHAT_DRAFT_LONG_KEY) ? draft : draft.slice(0, MAX_CHAT_TEXT);
  } catch {
    return null;
  }
}

function pageStorage(): Kept | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Anything a reload would lose: a text field or editable area holding more than whitespace, or a picked photo or file.
 * Chat's box does not count while it holds exactly its saved draft, which the reload brings back, unless a send of
 * those words is out or went unanswered: the page alone knows that send, and after a reload the same words in the
 * box would go as a second message.
 */
export function hasUnsent(doc: Pick<Document, "querySelectorAll">, storage: Kept | null = pageStorage(), sendOut: (words: string) => boolean = chatSendOut): boolean {
  if (doc.querySelectorAll(PICKED).length) return true;
  for (const field of doc.querySelectorAll<HTMLElement>("textarea, input:not([type]), input[type='text'], input[type='search'], [contenteditable='true'], [contenteditable='']")) {
    const text = "value" in field ? String(field.value) : field.textContent;
    if (!(text ?? "").trim()) continue;
    if (field.matches(CHAT_BOX) && text === savedDraft(storage) && !sendOut(text ?? "")) continue;
    return true;
  }
  return false;
}

type Watch = {
  doc?: Document;
  fetch?: typeof fetch;
  reload?: () => void;
  now?: () => number;
};

export function watchNewBuild({ doc = document, fetch = globalThis.fetch.bind(globalThis), reload = () => location.reload(), now = Date.now }: Watch = {}): () => Promise<void> {
  const loaded = doc.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null;
  let hiddenAt: number | null = null;
  const check = async (): Promise<void> => {
    if (doc.visibilityState === "hidden") {
      hiddenAt ??= now();
      return;
    }
    const away = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    if (away < AWAY_MS || !loaded) return;
    try {
      const response = await fetch("/", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return;
      const latest = mainScript(await response.text());
      if (latest && latest !== loaded && !hasUnsent(doc)) reload();
    } catch {
      // Offline: the next return tries again.
    }
  };
  doc.addEventListener("visibilitychange", () => void check());
  return check;
}
