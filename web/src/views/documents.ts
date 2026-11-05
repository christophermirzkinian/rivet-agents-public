import { readBody, stallWatch } from "../stall.js";
import { openPdf, openText } from "./lightbox.js";

// Which documents (a card's files, a chat's attachments) the app's own viewer shows, and fetching one to show or share.

export type PreviewKind = "pdf" | "markdown" | "text";

/** How the viewer shows a document of `type`, or null when it cannot. */
export function previewKind(type: string): PreviewKind | null {
  if (type === "application/pdf") return "pdf";
  if (type === "text/markdown") return "markdown";
  if (type === "text/plain" || type === "text/csv" || type === "application/json") return "text";
  return null;
}

/**
 * The document at `src`, checked to be what its type says, as a File named `name`; or what to tell the owner when it
 * could not be had. The server sends every text type as plain text.
 */
export async function fetchDocument(src: string, name: string, type: string, signal?: AbortSignal): Promise<File | string> {
  const noun = type === "application/pdf" ? "PDF" : "file";
  // A download that stops sending bytes fails rather than leaving the viewer, or Share, waiting forever.
  const watch = stallWatch(signal);
  try {
    const response = await fetch(src, { credentials: "same-origin", signal: watch.signal });
    if (!response.ok) {
      return response.status === 401 ? `Sign in again to get the ${noun}.` : response.status === 404 ? `That ${noun} is no longer on the server.` : `Could not get the ${noun}. Try again.`;
    }
    const served = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const body = new Blob([await readBody(response, watch)]);
    if (type === "application/pdf") {
      const head = new TextDecoder("latin1").decode(await body.slice(0, 5).arrayBuffer());
      if (served !== "application/pdf" || head !== "%PDF-") return "That file is not a PDF.";
    } else if (previewKind(type) ? !(served.startsWith("text/") || served === "application/json") : served !== type) {
      return "That file is not what its name says.";
    }
    return new File([body], name, { type });
  } catch {
    return watch.stalled() ? `The ${noun} stopped coming. Try again.` : `Could not get the ${noun}. Try again.`;
  } finally {
    watch.done();
  }
}

/** Opens a document the viewer can show (see previewKind); does nothing for any other. */
export function openDocument(name: string, type: string, get: () => Promise<File | string>): void {
  const kind = previewKind(type);
  if (kind === "pdf") openPdf(name, get);
  else if (kind) openText(name, kind === "markdown", get);
}
