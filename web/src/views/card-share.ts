import type { ServedNeed } from "../../../src/shared/board.js";
import { rivetWords } from "../../../src/shared/names.js";
import { h, svg } from "../dom.js";
import { onSessionReset, sameSession } from "../session.js";
import { mediaName } from "./card-media.js";
import { fetchDocument } from "./documents.js";
import { SHARE_ICON, shareable, shareAs } from "./share.js";
import { flash } from "./toast.js";

// Share on a card: its title and text go to the phone's share
// sheet, with its clip or screenshots and its files when it has them, so an update can go on to another app, or a
// document to the laptop. Only what the card shows goes: never its chat, PR comment links or ids.

/** The card as text to send on: its title, a blank line, then its text with its line breaks kept. */
export function cardShareText(need: Pick<ServedNeed, "title" | "ask">): string {
  const body = need.ask?.trim();
  return rivetWords(body ? `${need.title}\n\n${body}` : need.title);
}

/**
 * What goes with the card's text: its clip (After, else Before) or its screenshots, then each file a share sheet takes
 * (see shareAs), each with its URL, the name it goes under and its type.
 */
function shareRefs(need: Pick<ServedNeed, "title" | "media">): { src: string; name: string; type: string }[] {
  const media = need.media;
  if (!media) return [];
  const clip = media.after ?? media.before;
  const pictures = clip ? [[media.after ? "after" : "before", clip] as const] : (media.stills ?? []).map((ref, index) => [`${index + 1}`, ref] as const);
  return [
    ...pictures.map(([part, ref]) => ({ src: `/media/${ref.sha256}`, name: mediaName(need.title, part, ref), type: ref.type })),
    ...(media.files ?? []).filter((file) => shareAs(file.name, file.type)).map((file) => ({ src: `/media/${file.sha256}`, name: file.name, type: file.type })),
    // Sound clips go too, under their label.
    ...(media.clips ?? []).map((clip, index) => ({ src: `/media/${clip.sha256}`, name: `${clip.label ?? `Clip ${index + 1}`}.${clip.type === "audio/mp4" ? "m4a" : "mp3"}`, type: clip.type })),
  ];
}

// Chrome sends at most ten files and 50 MiB in one share and refuses the whole share past that, so the files go in the
// card's order while both last.
const MAX_FILES = 10;
const MAX_BYTES = 50 * 1024 * 1024;

function withinLimits(files: File[]): File[] {
  const sent: File[] = [];
  let bytes = 0;
  for (const file of files) {
    if (sent.length === MAX_FILES) break;
    if (bytes + file.size > MAX_BYTES) continue;
    bytes += file.size;
    sent.push(file);
  }
  return sent;
}

const failed = (error: unknown) => (error as Error | null)?.name;

/**
 * Files fetched for a card's Share, by card and revision, and the downloads under way: kept here, not on the button,
 * because the feed redraws its cards on every poll and the second tap lands on the new button. The last few only.
 */
const kept = new Map<string, File[]>();
const fetching = new Set<string>();
/** Cards none of whose files came: the next tap sends the text at once, and the one after tries the download again. */
const textNext = new Set<string>();
const KEEP = 3;

// A card's files are the session's: signing out (or in) forgets them and the downloads under way.
onSessionReset(() => {
  kept.clear();
  fetching.clear();
  textNext.clear();
});

function keep(key: string, files: File[]): void {
  kept.delete(key);
  kept.set(key, files);
  for (const old of kept.keys()) if (kept.size > KEEP) kept.delete(old);
}

/**
 * The card's Share button. The share sheet must open inside the tap: text alone goes at once, and a card with media
 * fetches its files first, keeping them, so when that download used the tap up a second tap sends them straight away.
 * Without the share API the text is copied instead.
 */
/**
 * `allowed` is asked again when a download finishes before anything goes to the share sheet: a thing can turn app-only
 * (a thread moved to an app-only project) while its files are still coming, and a redraw cannot cancel the tap already made.
 */
export function cardShareButton(need: ServedNeed, className: string, allowed: () => boolean = () => true): HTMLButtonElement {
  const text = cardShareText(need);
  const refs = shareRefs(need);
  const key = `${need.id}:${need.rev}`;
  const label = h("span", { class: "card-share-label" }, fetching.has(key) ? "Getting…" : "Share");
  const send = (data: ShareData) =>
    navigator.share(data).then(
      () => {},
      (error: unknown) => {
        if (failed(error) === "AbortError") return;
        if (failed(error) === "NotAllowedError" && data.files) return flash("Got the files. Tap Share again to send them.", "warn");
        flash("Couldn't open the share sheet. Try again.", "error");
      },
    );
  // message on Android puts a share's text under every file of a multi-file share, and a web share cannot caption the first file only. So two or more files go without it
  // and the text is copied for the owner to paste once; when it cannot be copied the files still carry it.
  const sendFiles = (files: File[]) => {
    if (files.length < 2 || !navigator.clipboard) return send({ files, text });
    // Nor does a copy that finishes after sign-out send them.
    const current = sameSession();
    return navigator.clipboard.writeText(text).then(
      () => {
        if (!current()) return;
        flash("Text copied. Paste it once as the caption.");
        return send({ files });
      },
      () => (current() ? send({ files, text }) : undefined),
    );
  };
  const element = h(
    "button",
    {
      class: `btn card-share ${className}`,
      attrs: { type: "button", "aria-label": `Share ${need.title}`, "data-share": key, ...(fetching.has(key) ? { "aria-busy": "true" } : {}), "data-use": className === "thing-btn" ? "chat.thing.share" : className.startsWith("upd-") ? "updates.pile.share" : "cards.share" },
      on: {
        click: (event) => {
          // Inside an update card the tap is Share's alone, never the card's open-the-thread.
          event.stopPropagation();
          if (typeof navigator.share !== "function") {
            if (!navigator.clipboard) return flash("Couldn't copy the card.", "error");
            navigator.clipboard.writeText(text).then(() => flash("Copied"), () => flash("Couldn't copy the card.", "error"));
            return;
          }
          if (!refs.length || typeof navigator.canShare !== "function") return void send({ text });
          if (textNext.delete(key)) return void send({ text });
          const files = kept.get(key);
          if (files) return void (files.length ? sendFiles(files) : send({ text }));
          if (fetching.has(key)) return;
          fetching.add(key);
          // A download that finishes after sign-out keeps nothing and opens no share sheet.
          const current = sameSession();
          label.textContent = "Getting…";
          element.setAttribute("aria-busy", "true");
          void Promise.all(refs.map((ref) => fetchDocument(ref.src, ref.name, ref.type)))
            .then((got) => {
              if (!current()) return;
              const came = got.filter((file): file is File => file instanceof File);
              // A Markdown file goes as plain text, which Chrome on Android takes.
              const files = withinLimits(came.flatMap((file) => shareable(file) ?? []));
              // What came is kept, so a second tap sends it at once; with none a share sheet takes (too big, or a phone
              // that cannot take them) the text goes alone from then on. When nothing came the text goes alone too, and
              // since a slow failure used the tap up, the next tap sends it at once rather than waiting on the download.
              const usable = files.length > 0 && navigator.canShare({ files, text });
              if (came.length) keep(key, usable ? files : []);
              else textNext.add(key);
              if (!allowed()) return;
              return usable ? sendFiles(files) : send({ text });
            })
            .finally(() => {
              // The reset already let go of it, and a tap in the new session may be getting it again.
              if (!current()) return;
              fetching.delete(key);
              // This button, and the one a redraw put in its place meanwhile.
              for (const shown of [element, ...document.querySelectorAll<HTMLElement>(`.card-share[data-share="${CSS.escape(key)}"]`)]) {
                shown.querySelector(".card-share-label")!.textContent = "Share";
                shown.removeAttribute("aria-busy");
              }
            });
        },
      },
    },
    svg(SHARE_ICON, "card-share-icon"),
    label,
  );
  return element;
}
