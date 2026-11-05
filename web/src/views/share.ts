import { h, svg } from "../dom.js";
import { SHARE_WAIT_MS, within } from "../within.js";

// Share and Download for anything on a card (a clip, a screenshot, a document) and in the viewer: the file itself goes to
// the phone's share sheet (message, Save to Files, Print…) or is saved to the device, never a link, since every /media/
// URL needs the owner's session.

export const SHARE_ICON =
  '<svg viewBox="0 0 24 24"><path d="M12 3v12M7.5 7.5L12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10.5H6a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8.5a1 1 0 0 0-1-1h-2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24"><path d="M12 3.5v11.5M7.5 10.5L12 15l4.5-4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 20h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

// Chrome on Android hands a file on only when its extension and its type are both on its own list (ShareServiceImpl),
// and canShare does not check that: share fails with NotAllowedError, so a Markdown file on a card said "Could not
// share the file" every time.
const SHARE_EXTENSIONS = new Set(
  "avif bmp css csv ehtml flac gif htm html ico jfif jpeg jpg m4a m4v mp3 mp4 mpeg mpg oga ogg ogm ogv opus pdf pja pjpeg png shtm shtml svg svgz text tif tiff txt wav weba webm webp xbm".split(" "),
);
const SHARE_TYPES = new Set(
  "application/pdf audio/flac audio/mp3 audio/mpeg audio/ogg audio/wav audio/webm audio/x-m4a image/avif image/bmp image/gif image/jpeg image/png image/svg+xml image/tiff image/webp image/x-icon image/x-ms-bmp image/x-xbitmap text/comma-separated-values text/css text/csv text/html text/plain video/mp4 video/mpeg video/ogg video/webm".split(" "),
);
const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json"];

/**
 * The name and type a file goes to the share sheet under: as it is when Chrome on Android takes it; a text document
 * (Markdown, a log, JSON) as plain text named .txt; an M4A under the type Chrome knows it by. Null when a phone's
 * share sheet takes no such file (an Office document, a ZIP, a HEIC…): Download saves those.
 */
export function shareAs(name: string, type: string): { name: string; type: string } | null {
  // Chrome also refuses a name with ".." in it, which a card's file name may have.
  const plain = name.replace(/\.{2,}/g, ".");
  const dot = plain.lastIndexOf(".");
  const extension = dot >= 0 ? plain.slice(dot + 1).toLowerCase() : "";
  if (SHARE_EXTENSIONS.has(extension) && SHARE_TYPES.has(type)) return { name: plain, type };
  if (TEXT_TYPES.includes(type)) return { name: `${dot > 0 ? plain.slice(0, dot) : plain}.txt`, type: "text/plain" };
  if (type === "audio/mp4" && extension === "m4a") return { name: plain, type: "audio/x-m4a" };
  return null;
}

/** `file` as the share sheet takes it (see shareAs), or null when it takes no such file. */
export function shareable(file: File): File | null {
  const as = shareAs(file.name, file.type);
  if (!as) return null;
  return as.name === file.name && as.type === file.type ? file : new File([file], as.name, { type: as.type });
}

/** Saves `file` to the device under its own name, from the copy in memory: the session-only /media/ URL never leaves. */
export function saveFile(file: File): void {
  const link = URL.createObjectURL(file);
  setTimeout(() => URL.revokeObjectURL(link), 60_000);
  const save = h("a", { attrs: { href: link, download: file.name } });
  save.hidden = true;
  document.body.append(save);
  save.click();
  save.remove();
}

/** A button's note: under it, or in the viewer's own (`say`), where it clears only a message it put there itself. */
function noteFor(say?: (text: string) => void): { note: HTMLElement; tell(message: string): void } {
  const note = h("p", { class: "media-file-note", attrs: { role: "status" } });
  note.hidden = true;
  let said = false;
  return {
    note,
    tell(message) {
      if (say) {
        if (message || said) say(message);
        said = Boolean(message);
        return;
      }
      note.textContent = message;
      note.hidden = !message;
    },
  };
}

export interface ShareOptions {
  /** The file, fetched (or handed back from a copy already kept), or what to tell the owner when it could not be had. */
  get: () => Promise<File | string>;
  /** The file already fetched (by Open, say), so a tap shares it at once, inside the tap. */
  peek?: () => File | null;
  /** The button's accessible name, e.g. "Share the After clip". */
  label: string;
  /** What it is in a failure message: "PDF", "clip", "screenshot". */
  noun: string;
  /** Without file sharing (a desktop browser): open the file in a new tab, or save it. */
  fallback: "open" | "download";
  /** False once the button's card or viewer has gone: a late download is then neither kept nor shared. */
  live?: () => boolean;
  /** Extra classes on the button. */
  className?: string;
  /** Where a failure message goes instead of the returned note (the image viewer has its own). */
  say?: (text: string) => void;
  /** The button is an icon on a phone, so a download that used up the tap says in words to tap again. */
  hint?: boolean;
}

const READY_HINT = "Got it. Tap Share again to send it.";

/**
 * A Share button and the note under it. The share must start inside a tap; when a slow download used that tap up, the
 * button keeps the file and a second tap shares it. The file is kept until `reset`, which a viewer calls when it
 * moves to another image.
 */
export function shareButton(options: ShareOptions): { button: HTMLButtonElement; note: HTMLElement; reset(): void } {
  const live = options.live ?? (() => true);
  const action = h("span", { class: "media-share-label" }, "Share");
  const button = h(
    "button",
    { class: `btn media-share${options.className ? ` ${options.className}` : ""}`, attrs: { type: "button", "aria-label": options.label, "data-use": "lightbox.share" } },
    svg(SHARE_ICON, "media-icon media-share-icon"),
    action,
  );
  const { note, tell } = noteFor(options.say);
  let kept: File | null = null;
  let busy = false;
  let round = 0;
  const show = (label: string, message = "") => {
    action.textContent = label;
    button.classList.toggle("ready", label === "Tap to share");
    tell(message);
  };
  const deliver = async (fresh: boolean) => {
    const file = kept!;
    if (!live()) return;
    // A round reset (another clip or picture picked) while the sheet was open is not this share's to report on.
    const at = round;
    const settle = (label: string, message = "") => {
      if (at === round) show(label, message);
    };
    const sendable = shareable(file);
    if (sendable && typeof navigator.canShare === "function" && navigator.canShare({ files: [sendable] })) {
      button.removeAttribute("aria-busy");
      show("Share");
      const shared = navigator.share({ files: [sendable] }).then(
        () => settle("Share"),
        (error: unknown) => {
          const name = (error as Error | null)?.name;
          if (name === "AbortError") settle("Share");
          else if (name === "NotAllowedError" && fresh) settle("Tap to share", options.hint ? READY_HINT : "");
          else settle("Share", `Could not share the ${options.noun}. Download saves it instead.`);
        },
      );
      await within(shared, SHARE_WAIT_MS, "share sheet still open").catch(() => settle("Share"));
      return;
    }
    if (options.fallback === "download") {
      saveFile(file);
      show("Share");
      return;
    }
    const link = URL.createObjectURL(file);
    setTimeout(() => URL.revokeObjectURL(link), 60_000);
    const tab = window.open(link, "_blank");
    if (tab) show("Share");
    else show("Share", "The browser blocked the new tab. Tap again to open it.");
  };
  const run = async (at: number) => {
    // A kept file shares before the first await, while the tap still counts.
    kept ??= options.peek?.() ?? null;
    if (kept) return deliver(false);
    show("Getting…");
    button.setAttribute("aria-busy", "true");
    const got = await options.get();
    // Moved on (another image in the viewer) or gone while it came: this file is no longer the one showing.
    if (at !== round) return;
    button.removeAttribute("aria-busy");
    if (!live()) return;
    if (typeof got === "string") return show("Share", got);
    kept = got;
    await deliver(true);
  };
  button.addEventListener("click", (event) => {
    // Over a clip or inside a card, the tap is Share's alone.
    event.stopPropagation();
    if (busy) return;
    busy = true;
    const at = round;
    void run(at).finally(() => {
      if (at === round) busy = false;
    });
  });
  return {
    button,
    note,
    reset() {
      round++;
      kept = null;
      busy = false;
      button.removeAttribute("aria-busy");
      show("Share");
    },
  };
}

/**
 * A Download button and the note under it: the file, fetched (or the copy already kept), saved to the device under its
 * own name (Chrome puts it in Downloads). A save needs no tap of its own, so a slow download still saves when it lands.
 * The file is kept until `reset`, as Share's is.
 */
export function downloadButton(options: Omit<ShareOptions, "fallback" | "hint">): { button: HTMLButtonElement; note: HTMLElement; reset(): void } {
  const live = options.live ?? (() => true);
  const action = h("span", { class: "media-share-label" }, "Download");
  const button = h(
    "button",
    { class: `btn media-download${options.className ? ` ${options.className}` : ""}`, attrs: { type: "button", "aria-label": options.label, "data-use": "lightbox.download" } },
    svg(DOWNLOAD_ICON, "media-icon media-share-icon"),
    action,
  );
  const { note, tell } = noteFor(options.say);
  let kept: File | null = null;
  let busy = false;
  let round = 0;
  const show = (label: string, message = "") => {
    action.textContent = label;
    tell(message);
  };
  button.addEventListener("click", (event) => {
    // Over a clip or inside a card, the tap is Download's alone.
    event.stopPropagation();
    if (busy) return;
    kept ??= options.peek?.() ?? null;
    if (kept) {
      show("Download");
      return saveFile(kept);
    }
    busy = true;
    const at = round;
    show("Getting…");
    button.setAttribute("aria-busy", "true");
    void options.get().then((got) => {
      // Moved on (another image in the viewer) while it came: this file is no longer the one showing.
      if (at !== round) return;
      busy = false;
      button.removeAttribute("aria-busy");
      if (!live()) return;
      if (typeof got === "string") return show("Download", got);
      kept = got;
      show("Download");
      saveFile(got);
    });
  });
  return {
    button,
    note,
    reset() {
      round++;
      kept = null;
      busy = false;
      button.removeAttribute("aria-busy");
      show("Download");
    },
  };
}
