import { MAX_MEDIA_BYTES } from "../../../src/shared/command.js";
import { readBody, stallWatch } from "../stall.js";
import { openPdf, openText } from "./lightbox.js";

// Which documents (a card's files, a chat's attachments) the app's own viewer shows, and fetching one to show or share.

export type PreviewKind = "pdf" | "markdown" | "text";

/** The most the viewer reads of a document into the phone's memory: card media's cap, and what a sent document could be before any file could be 500 MB. */
export const VIEWER_MAX_BYTES = MAX_MEDIA_BYTES;
/** The most fetchDocument reads of anything else (a clip or picture to share or save): what a sent clip could be before any file could be 500 MB. */
export const FETCH_MAX_BYTES = 100 * 1024 * 1024;
/** What fetchDocument answers for a file over `max`, which it never reads. */
export const tooBigToShow = (max: number): string => `That file is over ${Math.round(max / (1024 * 1024))} MB, too big to open here.`;
export const TOO_BIG_TO_SHOW = tooBigToShow(VIEWER_MAX_BYTES);

/** A document's size as a card's file and a chat line's PDF show it: "482 KB", "3.4 MB". */
export const fileSize = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** How the viewer shows a document of `type`, or null when it cannot. */
export function previewKind(type: string): PreviewKind | null {
  if (type === "application/pdf") return "pdf";
  if (type === "text/markdown") return "markdown";
  if (type === "text/plain" || type === "text/csv" || type === "application/json") return "text";
  return null;
}

/**
 * The document at `src`, checked to be what its type says, as a File named `name`; or what to tell the owner when it
 * could not be had. The server sends every text type as plain text. No more than `max` bytes of it are read.
 */
export async function fetchDocument(src: string, name: string, type: string, signal?: AbortSignal, max = FETCH_MAX_BYTES): Promise<File | string> {
  const noun = type === "application/pdf" ? "PDF" : "file";
  // A download that stops sending bytes fails rather than leaving the viewer, or Share, waiting forever.
  // `stop` ends the download itself, for a file too big to hold: aborting is what closes a body that is being read.
  const stop = new AbortController();
  if (signal?.aborted) stop.abort();
  else signal?.addEventListener("abort", () => stop.abort(), { once: true });
  const watch = stallWatch(stop.signal);
  let tooBig = false;
  try {
    const response = await fetch(src, { credentials: "same-origin", signal: watch.signal });
    if (!response.ok) {
      return response.status === 401 ? `Sign in again to get the ${noun}.` : response.status === 404 ? `That ${noun} is no longer on the server.` : `Could not get the ${noun}. Try again.`;
    }
    const served = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    // A sent file may be 500 MB and a chat line does not carry its size: the length is read here, and counted as the
    // bytes come when the server gave none, so no more than `max` is ever held.
    if (Number(response.headers.get("content-length") ?? 0) > max) {
      stop.abort();
      return tooBigToShow(max);
    }
    let got = 0;
    const body = new Blob([
      await readBody(response, watch, (n) => {
        got += n;
        if (got > max) {
          tooBig = true;
          stop.abort();
          throw new Error("too big");
        }
      }),
    ]);
    if (type === "application/pdf") {
      const head = new TextDecoder("latin1").decode(await body.slice(0, 5).arrayBuffer());
      if (served !== "application/pdf" || head !== "%PDF-") return "That file is not a PDF.";
    } else if (previewKind(type) ? !(served.startsWith("text/") || served === "application/json") : served !== type) {
      return "That file is not what its name says.";
    }
    return new File([body], name, { type });
  } catch {
    if (tooBig) return tooBigToShow(max);
    return watch.stalled() ? `The ${noun} stopped coming. Try again.` : `Could not get the ${noun}. Try again.`;
  } finally {
    watch.done();
  }
}

/** Opens a document the viewer can show (see previewKind); does nothing for any other. `share` saying no: Download only. */
export function openDocument(name: string, type: string, get: () => Promise<File | string>, share: () => boolean = () => true): void {
  const kind = previewKind(type);
  if (kind === "pdf") openPdf(name, get, share);
  else if (kind) openText(name, kind === "markdown", get, share);
}
