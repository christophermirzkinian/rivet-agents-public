import type { Decision } from "./board.js";

// The Media tab (2026-10-03): every photo and video Rivet sent you, on a card or in the chat, newest first. The
// record outlives the card; the files stay in the media store and are served only at the session's /media/<sha256>.

export const MEDIA_PAGE_MAX = 120;

export type MediaSource = "card" | "chat";
export type MediaItemType = "image/jpeg" | "image/png" | "video/mp4" | "video/webm";

/** Your answer to a card, from its reply. */
export interface MediaAnswer {
  decision: Decision;
  choice?: string;
  text?: string;
  at: string;
}

export interface MediaItem {
  sha: string;
  type: MediaItemType;
  /** A video's poster image, while it is still stored. */
  poster?: string;
  /** When it was sent: the board write that first named it (its upload, for a card from before the record), a chat message's time. */
  at: string;
  source: MediaSource;
  /** The card's title, or the conversation's. */
  title: string;
  /** `ask` is what the card asked, kept with your answer. A card's file from before the record has none. */
  card?: { id: string; onBoard: boolean; ask?: string; answer?: MediaAnswer };
  chat?: { conversation: string; message: string };
}

/** GET /api/media: newest first; `next` asks for the page after it as `?before=`. */
export interface MediaPage {
  items: MediaItem[];
  next: string | null;
}

/** A page cursor: the last item's time and its record's sequence number. */
export const MEDIA_CURSOR = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)~(\d{1,15})$/;
