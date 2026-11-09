import { FILE_EXTENSIONS, fileTypeOf, isAvType, isBigType, MAX_AV_BYTES, MAX_CHAT_FILES, type FileRef } from "../../../src/shared/board.js";
import { MAX_CHAT_IMAGES, MAX_FILE_BYTES, type ChatFile } from "../../../src/shared/command.js";
import { ApiError, uploadFile, uploadImage } from "../api.js";
import { button, describe, h, keepFocus, svg } from "../dom.js";
import { prepareImage } from "../image.js";
import { fetchDocument, fileSize, openDocument, previewKind } from "./documents.js";
import { openImages } from "./lightbox.js";

// The attach button and its preview, for the Chat composer, the card answer sheet and the desktop comment box alike:
// several photos and several files. A photo is prepared and uploaded as soon as it is picked, and a file uploaded as
// it is, so Send only has to name them. State lives with the caller, so a view that is rebuilt (the card sheet) shows
// the same attachments again.

/** A paper clip: the button takes photos and documents alike. */
const CLIP =
  '<svg viewBox="0 0 24 24"><path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const PHOTO =
  '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="9" cy="10.5" r="1.8" fill="currentColor"/><path d="M4.5 17.5l5-4.5 3.5 3 2.5-2 4 3.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';

export const PHOTO_FAILED = "The photo didn't upload. Try again or remove it.";
export const FILE_FAILED = "The file didn't upload. Try again or remove it.";
export const FILE_REFUSED = "That file type can't be sent. Attach photos, videos, music, PDFs, text files, Office documents, emails, ZIPs or GLB models.";
export const FILE_TOO_BIG = "That file is over 25 MB. Send a smaller one.";
export const AV_TOO_BIG = "That video or sound file is over 100 MB. Send a shorter one.";
export const BIG_TOO_BIG = "That file is over 100 MB. Send a smaller one.";

/** What the picker offers: photos, and the documents, videos and sound the server takes, by extension and by type (iOS lists both). */
export const ACCEPT = ["image/*", ...Object.keys(FILE_EXTENSIONS).map((extension) => `.${extension}`), ...new Set(Object.values(FILE_EXTENSIONS))].join(",");

const PHOTO_EXTENSION = /\.(?:jpe?g|png|heic|heif|webp)$/i;

/**
 * How a picked file travels: a photo is redrawn, a document, video or sound file goes as it is, anything else is
 * refused at once. A GIF goes as a file, as a redraw would stop it moving.
 */
export function sortPick(file: File): { kind: "photo" } | { kind: "file" } | { kind: "refused"; reason: string } {
  const type = fileTypeOf(file.name);
  // Some pickers give a photo no type, or a generic one: its extension says it is a photo, and the redraw checks it is.
  if (type !== "image/gif" && (file.type.startsWith("image/") || PHOTO_EXTENSION.test(file.name))) return { kind: "photo" };
  if (!type) return { kind: "refused", reason: FILE_REFUSED };
  if (isBigType(type)) return file.size > MAX_AV_BYTES ? { kind: "refused", reason: isAvType(type) ? AV_TOO_BIG : BIG_TOO_BIG } : { kind: "file" };
  return file.size > MAX_FILE_BYTES ? { kind: "refused", reason: FILE_TOO_BIG } : { kind: "file" };
}

const DOC =
  '<svg viewBox="0 0 24 24"><path d="M6 3h8l5 5v13H6z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M14 3v5h5M9 13h7M9 17h7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

/** A PDF: the page with its corner turned and a PDF band across it. */
const PDF_DOC =
  '<svg viewBox="0 0 24 24"><path d="M6 3h8l5 5v13H6z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><rect x="2" y="11" width="16" height="8" rx="1.5" fill="#d93025"/><text x="10" y="17.4" text-anchor="middle" font-family="system-ui, sans-serif" font-size="6.4" font-weight="800" fill="#fff">PDF</text></svg>';

/**
 * A document as the strip and the bubbles show it: its icon and its name, and under the name its size when it is known
 * (Rivet's PDF, say.mjs --file).
 */
export function fileChip(name: string, bytes?: number): HTMLElement {
  // The stem gives way to an ellipsis; the extension always shows, so a long name still says what kind of file it is.
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const pdf = extension.toLowerCase() === ".pdf";
  const shown = h("span", { class: "file-chip-name" }, h("span", { class: "file-chip-stem" }, stem), extension ? h("span", { class: "file-chip-ext" }, extension) : null);
  return h(
    "span",
    { class: `file-chip${bytes === undefined ? "" : " file-chip-sized"}`, attrs: { title: name } },
    svg(pdf ? PDF_DOC : DOC, "file-chip-icon"),
    bytes === undefined
      ? shown
      : h("span", { class: "file-chip-text" }, shown, h("span", { class: "file-chip-size" }, `${pdf ? "PDF" : extension.slice(1).toUpperCase() || "File"} · ${fileSize(bytes)}`)),
  );
}

const CROSS = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

/** One photo, or one document (`doc`), in the Chat composer's strip. */
export interface Photo {
  /** The uploaded image's sha256, once the server has it. */
  image: string | null;
  /** A blob: URL of the prepared image, once it is ready. */
  preview: string | null;
  busy: boolean;
  error: string | null;
  /** Stops this photo's upload and frees the upload queue for the photos after it. */
  cancel?: () => void;
  /** A document rather than a photo: its name to show (the picked file's, then the server's), and its ref once uploaded. */
  doc?: { name: string; file: FileRef | null };
}

/** The photos and documents to send, in the order they were picked. */
export interface PhotosState {
  photos: Photo[];
  /** Why the last pick left photos out; cleared by the next pick or remove. */
  notice: string | null;
}

/** Each attachment's own number, so a redraw keeps the keyboard on its tile even when two share a file name. */
const tileIds = new WeakMap<Photo, number>();
let tilesMade = 0;

export function emptyPhotos(): PhotosState {
  return { photos: [], notice: null };
}

/** Drops these photos (every one by default) and releases their previews; an upload still going for one is then ignored. */
export function dropPhotos(state: PhotosState, photos: readonly Photo[] = state.photos): void {
  for (const photo of photos) {
    photo.cancel?.();
    if (photo.preview?.startsWith("blob:")) URL.revokeObjectURL(photo.preview);
  }
  state.photos = state.photos.filter((photo) => !photos.includes(photo));
  state.notice = null;
}

export interface PhotosControl {
  button: HTMLButtonElement;
  preview: HTMLElement;
  /** Takes these files as if picked, with `notices` beside the pick's own: a share from another app arrives this way. */
  add(files: File[], notices?: string[]): void;
  /** Drops these photos once they have been sent. */
  drop(photos: readonly Photo[]): void;
}

/**
 * The attach button and its strip of up to MAX_CHAT_IMAGES photos and MAX_CHAT_FILES documents, each with its own
 * remove button; a photo's preview opens full screen. They are uploaded one at a time, in the order picked, so a phone
 * never decodes ten at once. `label` gives the button words beside its clip.
 */
export function photosControl(state: PhotosState, options: { onChange(): void; onSignedOut(): void; label?: string; use?: string }): PhotosControl {
  const input = h("input", { class: "attach-input", attrs: { type: "file", accept: ACCEPT, multiple: "", tabindex: "-1", "aria-hidden": "true" } });
  const pickButton = options.label
    ? button([svg(CLIP, "btn-icon"), options.label], () => input.click(), "attach-btn", false, options.use ?? "attach")
    : h(
        "button",
        { class: "icon-btn attach-btn", attrs: { type: "button", "aria-label": "Attach photos or files", "data-use": options.use ?? "attach" }, on: { click: () => input.click() } },
        svg(CLIP, "icon-btn-icon"),
      );
  const strip = h("ul", { class: "attach-strip", attrs: { "aria-label": "Photos and files to send" } });
  const note = h("p", { class: "attach-note", attrs: { role: "status" } });
  const notice = h("p", { class: "attach-note attach-notice", attrs: { role: "status" } });
  // Documents stack in rows under the photos, so none hides off the side of the sideways photo strip.
  const docs = h("ul", { class: "attach-docs", attrs: { "aria-label": "Files to send" } });
  const preview = h("div", { class: "attach-preview attach-photos" }, strip, docs, note, notice);
  let queue = Promise.resolve();

  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length) pick(files);
  });

  function update(): void {
    render();
    options.onChange();
  }

  const present = (photo: Photo) => state.photos.includes(photo);
  const count = (docs: boolean) => state.photos.filter((photo) => (photo.doc !== undefined) === docs).length;

  function pick(files: File[], extra: readonly string[] = []): void {
    let photoRoom = Math.max(MAX_CHAT_IMAGES - count(false), 0);
    let fileRoom = Math.max(MAX_CHAT_FILES - count(true), 0);
    let photosLeft = 0;
    let filesLeft = 0;
    const refused = new Set<string>();
    for (const file of files) {
      const sorted = sortPick(file);
      if (sorted.kind === "refused") {
        refused.add(sorted.reason);
        continue;
      }
      const doc = sorted.kind === "file";
      if (doc ? fileRoom === 0 : photoRoom === 0) {
        if (doc) filesLeft += 1;
        else photosLeft += 1;
        continue;
      }
      if (doc) fileRoom -= 1;
      else photoRoom -= 1;
      const photo: Photo = { image: null, preview: null, busy: true, error: null, ...(doc ? { doc: { name: file.name, file: null } } : {}) };
      const abort = new AbortController();
      // A removed photo leaves the queue at once, even mid-upload, so the photos after it never wait on it.
      const removed = new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
      photo.cancel = () => abort.abort();
      state.photos.push(photo);
      queue = queue.then(() => Promise.race([load(photo, file, abort.signal), removed]));
    }
    const notices = [
      ...extra,
      ...refused,
      ...(photosLeft ? [`A message takes up to ${MAX_CHAT_IMAGES} photos, so ${photosLeft === 1 ? "1 was" : `${photosLeft} were`} left out.`] : []),
      ...(filesLeft ? [`A message takes up to ${MAX_CHAT_FILES} files, so ${filesLeft === 1 ? "1 was" : `${filesLeft} were`} left out.`] : []),
    ];
    state.notice = notices.length ? notices.join(" ") : null;
    update();
  }

  /** Whether a photo the browser could not draw can go as a file instead: a HEIC or HEIF, with room for one more file. */
  const asFile = (file: File) => {
    const type = fileTypeOf(file.name);
    return (type === "image/heic" || type === "image/heif") && file.size <= MAX_FILE_BYTES && count(true) < MAX_CHAT_FILES;
  };

  async function load(photo: Photo, file: File, signal: AbortSignal): Promise<void> {
    if (!present(photo)) return;
    try {
      if (photo.doc) {
        const { sha256, name } = await uploadFile(file, signal);
        if (!present(photo)) return;
        photo.doc = { name, file: { sha256, name } };
        return;
      }
      const prepared = await prepareImage(file).catch((error: unknown) => {
        if (asFile(file)) return null;
        throw error;
      });
      if (!present(photo)) return;
      if (!prepared) {
        // A HEIC this browser cannot draw (Chrome's) goes as it is, a file a chat can convert.
        photo.doc = { name: file.name, file: null };
        update();
        const { sha256, name } = await uploadFile(file, signal);
        if (!present(photo)) return;
        photo.doc = { name, file: { sha256, name } };
        return;
      }
      photo.preview = URL.createObjectURL(prepared);
      update();
      const { image } = await uploadImage(prepared, signal);
      if (!present(photo)) return;
      photo.image = image;
    } catch (error) {
      if (!present(photo)) return;
      if (photo.preview) URL.revokeObjectURL(photo.preview);
      photo.preview = null;
      photo.error = describe(error);
      if (error instanceof ApiError && error.status === 401) options.onSignedOut();
    } finally {
      if (present(photo)) {
        photo.busy = false;
        update();
      }
    }
  }

  function tile(photo: Photo, index: number): HTMLElement {
    if (!tileIds.has(photo)) tileIds.set(photo, ++tilesMade);
    // Photos are numbered among the photos, as their alt text and remove labels always were.
    const number = state.photos.slice(0, index + 1).filter((other) => !other.doc).length;
    return h(
      "li",
      { class: `attach-tile${photo.doc ? " attach-doc" : ""}${photo.error ? " failed" : ""}`, attrs: { "data-attach": String(tileIds.get(photo)) } },
      photo.doc
        ? fileChip(photo.doc.name)
        : photo.preview
          ? h(
              "button",
              {
                class: "attach-open",
                attrs: { type: "button", "aria-label": `Photo ${number} to send, full screen`, "data-use": "attach.preview" },
                on: { click: () => openPreviews(photo) },
              },
              h("img", { class: "attach-thumb", attrs: { src: photo.preview, alt: `Photo ${number} to send`, decoding: "async" } }),
            )
          : h("span", { class: "attach-wait", attrs: { "aria-hidden": "true" } }, photo.error ? "!" : "…"),
      h(
        "button",
        {
          class: "attach-remove",
          attrs: { type: "button", "aria-label": photo.doc ? `Remove ${photo.doc.name}` : `Remove photo ${number}`, "data-use": "attach.remove" },
          on: {
            click: () => {
              dropPhotos(state, [photo]);
              update();
            },
          },
        },
        svg(CROSS, "attach-remove-icon"),
      ),
    );
  }

  /** The ready previews full screen, from this photo's; the lightbox reads the local blob, so nothing is fetched. */
  function openPreviews(photo: Photo): void {
    const ready = state.photos.filter((other) => !other.doc && other.preview !== null);
    openImages(
      ready.map((other) => other.preview!),
      Math.max(0, ready.indexOf(photo)),
      "Photo to send",
    );
  }

  function status(): string {
    const total = state.photos.length;
    const docs = count(true);
    const photos = total - docs;
    const busy = state.photos.filter((photo) => photo.busy).length;
    if (busy) {
      if (total === 1) return docs ? "Uploading the file…" : "Getting the photo ready…";
      return `Getting ${busy} of ${total} ${docs === 0 ? "photos" : photos === 0 ? "files" : "attachments"} ready…`;
    }
    if (docs === 0) return photos === 1 ? "Photo attached" : `${photos} photos attached`;
    if (photos === 0) return docs === 1 ? "File attached" : `${docs} files attached`;
    return `${photos === 1 ? "1 photo" : `${photos} photos`} and ${docs === 1 ? "1 file" : `${docs} files`} attached`;
  }

  function render(): void {
    pickButton.disabled = count(false) >= MAX_CHAT_IMAGES && count(true) >= MAX_CHAT_FILES;
    preview.hidden = state.photos.length === 0 && state.notice === null;
    const refocus = [keepFocus(strip), keepFocus(docs)];
    const tiles = state.photos.map((photo, index) => ({ photo, tile: tile(photo, index) }));
    strip.replaceChildren(...tiles.filter((item) => !item.photo.doc).map((item) => item.tile));
    docs.replaceChildren(...tiles.filter((item) => item.photo.doc).map((item) => item.tile));
    strip.hidden = strip.childElementCount === 0;
    docs.hidden = docs.childElementCount === 0;
    for (const put of refocus) put();
    const failed = state.photos.find((photo) => photo.error !== null);
    note.classList.toggle("error", failed !== undefined);
    note.textContent = failed?.error ?? (state.photos.length ? status() : "");
    note.hidden = state.photos.length === 0;
    notice.textContent = state.notice ?? "";
    notice.hidden = state.notice === null;
  }

  render();
  return {
    button: pickButton,
    preview: h("div", { class: "attach-wrap" }, input, preview),
    add(files, notices = []) {
      if (files.length || notices.length) pick(files, notices);
    },
    drop(photos) {
      dropPhotos(state, photos);
      update();
    },
  };
}

/** Why these attachments cannot be sent yet, or null. */
export function photosHold(photos: readonly Photo[]): string | null {
  const docs = photos.filter((photo) => photo.doc).length;
  if (photos.some((photo) => photo.busy)) {
    if (photos.length === 1) return docs ? "The file is still uploading." : "The photo is still getting ready.";
    return docs ? "The attachments are still getting ready." : "The photos are still getting ready.";
  }
  const failed = photos.find((photo) => photo.error);
  return failed ? (failed.doc ? FILE_FAILED : PHOTO_FAILED) : null;
}

/** What these attachments send, once photosHold passes: each photo's sha256 and each document's ref, in order, none twice. */
export function photosPayload(photos: readonly Photo[]): { images: string[]; files: FileRef[] } {
  const images = [...new Set(photos.filter((photo) => !photo.doc).map((photo) => photo.image!))];
  const files = photos
    .filter((photo) => photo.doc)
    .map((photo) => photo.doc!.file!)
    .filter((file, index, all) => all.findIndex((other) => other.sha256 === file.sha256) === index);
  return { images, files };
}

/** Attachments already on the server, shown as they were picked: an answer put back after the app closed. */
export function restorePhotos(state: PhotosState, images: readonly string[], files: readonly FileRef[] = []): void {
  dropPhotos(state);
  state.photos = [
    ...images.map((image): Photo => ({ image, preview: mediaSrc(image), busy: false, error: null })),
    ...files.map((file): Photo => ({ image: null, preview: null, busy: false, error: null, doc: { name: file.name, file } })),
  ];
}

/** Where the app reads an attachment the server stores. */
export function mediaSrc(sha: string): string {
  return `/media/${encodeURIComponent(sha)}`;
}

/** A sent photo that opens full screen, with the other photos sent beside it a swipe away. */
export function imageButton(srcs: string[], index: number, img: HTMLImageElement): HTMLElement {
  return h(
    "button",
    {
      class: "chat-image-open",
      attrs: { type: "button", "aria-label": srcs.length > 1 ? `Photo ${index + 1} of ${srcs.length}, full screen` : "Photo, full screen", "data-use": "chat.msg.image" },
      on: { click: () => openImages(srcs, index, "Photo") },
    },
    img,
  );
}

/**
 * A sent document. One the app can show (PDF, Markdown, text, JSON) opens in its viewer; any other, or a click
 * that asks for a new tab, follows the link, which downloads it or opens it in the browser.
 */
export function fileLink(file: ChatFile, share: () => boolean = () => true): HTMLElement {
  const href = `${mediaSrc(file.sha256)}?name=${encodeURIComponent(file.name)}`;
  const type = fileTypeOf(file.name);
  const sized = typeof file.bytes === "number" && file.bytes > 0 ? file.bytes : undefined;
  const link = h("a", { class: "chat-file", attrs: { href, target: "_blank", rel: "noopener", "data-use": "chat.msg.file" } }, fileChip(file.name, sized));
  if (type && previewKind(type)) {
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openDocument(file.name, type, () => fetchDocument(href, file.name, type), share);
    });
  }
  return link;
}

/**
 * What went, or goes, with a card answer: its photos as tiles that open full screen, its documents as links that open
 * in the viewer. `srcs` are the photos' URLs, a local preview's included.
 */
export function attachedList(srcs: readonly string[], files: readonly (FileRef | string)[], alt: string): HTMLElement | null {
  if (!srcs.length && !files.length) return null;
  return h(
    "div",
    { class: "sent-attach" },
    srcs.length
      ? h(
          "div",
          { class: "chat-images" },
          ...srcs.map((src, index) =>
            imageButton([...srcs], index, h("img", { class: "chat-image-tile", attrs: { src, alt: srcs.length > 1 ? `${alt}, ${index + 1} of ${srcs.length}` : alt, loading: "lazy", decoding: "async" } })),
          ),
        )
      : null,
    files.length
      ? h("ul", { class: "chat-files" }, ...files.map((file) => h("li", {}, typeof file === "string" ? h("span", { class: "chat-file" }, fileChip(file)) : fileLink(file))))
      : null,
  );
}
