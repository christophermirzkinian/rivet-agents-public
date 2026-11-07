import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import type { ReopenEvent } from "../shared/answered.js";
import type { Reply } from "../shared/board.js";
import { chatWindowText, MAX_CHAT_IMAGES } from "../shared/command.js";
import { BATCH_MAX_TEXT, OLD_BRIDGE_CHAT_TEXT, SHORT_CHAT_BRIDGE_TEXT, SHORT_CHAT_WINDOW_TEXT } from "./commandstore.js";

const PING_MS = 15_000;
/**
 * How long a dropped bridge still counts as connected for the app's Mac pill: a normal
 * reconnect takes up to ~30 s, and showing "Mac offline" for each one said the Mac
 * was down while it was fine. Delivery never waits on this: it needs `current`.
 */
export const OFFLINE_GRACE_MS = 90_000;

/** What a bridge build says it can take beyond text, on the event stream request; an older bridge sends nothing. */
export const FEATURES_HEADER = "x-rivet-bridge-features";
/**
 * `chat-window`: the bridge types a chat window of up to 3800 characters whole; an older one cuts its line at 2000.
 * `long-chat`: the bridge types a chat window of up to 20,000 characters (40,000 once line breaks fold to " | ") whole;
 * one with only `chat-window` refuses text past 4000.
 * `images`: the bridge takes a chat event's `images`, two or more photos; an older one would type the text and drop them.
 * `files`: the bridge names a chat event's or reply's `files` in its line; an older one would drop them.
 * `reply-images`: the bridge takes a reply's `images`, two or more photos; an older one would drop the reply.
 * `choice-detail`: the bridge retains the selected option detail; older bridges silently discard it.
 * `card-merge`: the bridge posts no GitHub comment for a merge-ready card's arming answer; an older one would, and that
 * comment would keep the PR from merging.
 * `ask-late`: the bridge types a late ask's or late Ops item's question into the monitor chat; an older one would drop the event.
 * `changes`: the bridge's chat line says a reply changes an earlier answer (Answer again); an older one drops that.
 * `reopen`: the bridge types a Reopen of an answered card into the monitor chat, for the card's chat; an older one would drop it.
 * `ops-pickup`: the bridge types the auto pick-up's rivet fix ask into the monitor chat; an older one would drop it.
 * `home-control`: the bridge runs the Home page's buttons; an older one would drop them.
 */
const KNOWN_FEATURES = ["image", "chat-window", "long-chat", "images", "files", "reply-images", "card-merge", "dismiss", "choice-detail", "ask-late", "changes", "reopen", "ops-pickup", "home-control"] as const;
export type BridgeFeature = (typeof KNOWN_FEATURES)[number];

/** A comma list of [a-z-]+ tokens; anything else is no features at all. Unknown tokens are dropped. */
export function parseFeatures(value: string | string[] | undefined): Set<BridgeFeature> {
  if (typeof value !== "string" || value.length > 200) return new Set();
  const tokens = value.split(",").map((token) => token.trim());
  if (!tokens.every((token) => /^[a-z-]+$/.test(token))) return new Set();
  return new Set(KNOWN_FEATURES.filter((feature) => tokens.includes(feature)));
}

/** The single SSE connection to the Mac bridge. A new connection replaces the old one. */
export class BridgeChannel {
  private current: { response: ServerResponse; ping: NodeJS.Timeout } | null = null;
  private lastSeen: number | null = null;
  /** When the event stream last closed; the bridge's other uploads (seen) never move it. */
  private droppedAt: number | null = null;
  /** The features of the most recent bridge connection; null until one connects. */
  private features: Set<BridgeFeature> | null = null;
  private readonly attachListeners: (() => void)[] = [];

  /** Why a send carrying a photo is refused now, or null when the last bridge said it takes them. */
  photoRefusal(): string | null {
    if (this.features === null) return "The Mac's bridge hasn't connected since the server restarted. Try the photo again in a minute.";
    return this.features.has("image") ? null : "The Mac's bridge needs updating before it can take photos.";
  }

  /** Why a card reply carrying `count` photos is refused now, or null; one photo travels as `image`, which every photo bridge takes. */
  replyPhotosRefusal(count: number): string | null {
    if (count === 0) return null;
    const refusal = this.photoRefusal();
    if (refusal || count === 1) return refusal;
    return this.features!.has("reply-images") ? null : "The Mac's bridge needs updating before an answer can take several photos. Send one photo for now.";
  }

  /**
   * Why a chat message too long for the last bridge that connected is refused now, or null. Refused rather than held:
   * a window held for a newer bridge would let a later, shorter message (a "stop") reach Rivet before it.
   */
  chatTextRefusal(text: string | undefined): string | null {
    if (text === undefined || chatWindowText([text]).length <= this.bridgeTextMax()) return null;
    if (this.features === null) return "The Mac's bridge hasn't connected since the server restarted. Try the long message again in a minute.";
    return `The Mac's bridge needs updating before it can take a message this long. Keep it under ${this.bridgeTextMax().toLocaleString("en-AU")} characters for now.`;
  }

  /** The most chat text, as typed (chatWindowText), the last bridge that connected takes whole. */
  private bridgeTextMax(): number {
    if (this.features?.has("long-chat")) return Infinity;
    return this.features?.has("chat-window") ? SHORT_CHAT_BRIDGE_TEXT : OLD_BRIDGE_CHAT_TEXT;
  }

  /** Why a send carrying a document is refused now, or null when the last bridge said it takes them. */
  fileRefusal(): string | null {
    if (this.features === null) return "The Mac's bridge hasn't connected since the server restarted. Try the file again in a minute.";
    return this.features.has("files") ? null : "The Mac's bridge needs updating before it can take files.";
  }

  /** Why an answer that arms a merge-ready card's merge is refused now, or null when the last bridge said it takes one. */
  cardMergeRefusal(): string | null {
    if (this.features === null) return "The Mac's bridge hasn't connected since the server restarted. Try the answer again in a minute.";
    return this.features.has("card-merge") ? null : "The Mac's bridge needs updating before a Merge answer can merge.";
  }

  /** Why Answer again is refused now, or null when the last bridge said its chat line names the answer changed. */
  changesRefusal(): string | null {
    if (this.features === null) return "The Mac's bridge hasn't connected since the server restarted. Try again in a minute.";
    return this.features.has("changes") ? null : "The Mac's bridge needs updating before an answer can be changed.";
  }

  /** A Reopen's notice for the monitor chat; false with no bridge that takes one, and the next connect offers it again. */
  sendReopen(event: ReopenEvent): boolean {
    if (!this.current || this.features?.has("reopen") !== true) return false;
    this.current.response.write(`event: reopen\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    return true;
  }

  /** Why a Dismiss is refused now, or null when the last bridge said it takes one (an older one drops it as a bad decision). */
  dismissRefusal(): string | null {
    if (this.features === null) return "The Mac's bridge hasn't connected since the server restarted. Try Dismiss again in a minute.";
    return this.features.has("dismiss") ? null : "The Mac's bridge needs updating before it can take Dismiss.";
  }

  /** How long a chat window may grow for the last bridge that connected, so it types every message whole. */
  chatWindowMax(): number {
    if (this.features?.has("long-chat")) return BATCH_MAX_TEXT;
    return this.features?.has("chat-window") ? SHORT_CHAT_WINDOW_TEXT : OLD_BRIDGE_CHAT_TEXT;
  }

  /** How many photos a chat window may gather for the last bridge that connected; an older one takes one per window. */
  chatWindowImages(): number {
    return this.features?.has("images") ? MAX_CHAT_IMAGES : 1;
  }

  attach(response: ServerResponse, backlog: Reply[], features: Set<BridgeFeature> = new Set()): void {
    this.detach();
    this.features = features;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    const ping = setInterval(() => {
      response.write(": ping\n\n");
      this.seen();
    }, PING_MS);
    const entry = { response, ping };
    this.current = entry;
    this.droppedAt = null;
    this.seen();
    response.on("close", () => {
      clearInterval(ping);
      if (this.current === entry) {
        this.current = null;
        this.droppedAt = Date.now();
        this.seen();
      }
    });
    for (const reply of backlog) this.send(reply);
    for (const listener of this.attachListeners) listener();
  }

  /** Runs after each new connection's own backlog, so an area can replay its events. */
  onAttach(listener: () => void): void {
    this.attachListeners.push(listener);
  }

  /**
   * A photo never goes to a connection that did not say it takes them: an older
   * bridge would type the text, ack, and lose the photo. The event stays pending
   * for a bridge that can. Several photos (`images`) likewise wait for a bridge that said `images`, and documents
   * (`files`) for one that said `files`, even when they were collected while one was connected.
   */
  private takes(data: unknown): boolean {
    const { image, images, files } =
      typeof data === "object" && data !== null ? (data as { image?: unknown; images?: unknown; files?: unknown }) : {};
    if (images !== undefined && this.features?.has("images") !== true) return false;
    if (files !== undefined && this.features?.has("files") !== true) return false;
    return image === undefined || this.features?.has("image") === true;
  }

  /**
   * Text past 2000 characters (a chat window) never goes to a connection that did not say `chat-window`, nor text past
   * 4000 to one that did not say `long-chat`: an older bridge would cut the line, or refuse it, and lose the rest. It
   * stays queued for a bridge that can, even when the window was collected while a newer bridge was connected.
   */
  private fitsText(data: unknown): boolean {
    const text = typeof data === "object" && data !== null ? (data as { text?: unknown }).text : undefined;
    return typeof text !== "string" || text.length <= this.bridgeTextMax();
  }

  /** Any other event family; false when the bridge is not connected or cannot take it yet. */
  sendEvent(event: string, id: string, data: unknown): boolean {
    if (!this.current || !this.takes(data) || !this.fitsText(data)) return false;
    this.current.response.write(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  }

  /** A reply's several photos wait for a bridge that said `reply-images`: one that says only `images` would drop them. */
  send(reply: Reply): void {
    // Keep the stored reply pending until its complete selected scope can be delivered.
    if (reply.item.choiceDetail !== undefined && this.features?.has("choice-detail") !== true) return;
    // An older bridge would take a merge answer as a plain approve, and its ack would then start the merge unseen.
    if (reply.item.merge === true && this.features?.has("card-merge") !== true) return;
    if (!this.takes(reply) || (reply.images !== undefined && this.features?.has("reply-images") !== true)) return;
    // A Dismiss waits for a bridge that said dismiss: an older one drops it as a bad decision, unacked and undelivered.
    if (reply.decision === "dismiss" && this.features?.has("dismiss") !== true) return;
    // A changed answer waits for a bridge that said changes: an older one drops what it changes and relays it as plain.
    if (reply.item.changes !== undefined && this.features?.has("changes") !== true) return;
    this.current?.response.write(`event: reply\nid: ${reply.id}\ndata: ${JSON.stringify(reply)}\n\n`);
  }

  /**
   * An unowned red item for the monitor to run rivet fix on: its kind, key, repo and reason only, which the bridge puts in
   * its own sentence after checking each. Returns the event id the bridge acks, or null with no capable bridge; the next tick tries again.
   */
  sendOpsPickup(pickup: { kind: string; key: string; repo: string; detail?: string }): string | null {
    if (!this.current || this.features?.has("ops-pickup") !== true) return null;
    const id = randomUUID();
    this.current.response.write(`event: ops-pickup\nid: ${id}\ndata: ${JSON.stringify({ id, ...pickup })}\n\n`);
    return id;
  }

  /**
   * A Home page button for the bridge to run in Home Assistant, with when the server stops waiting (epoch ms) so a press
   * held up behind other bridge work is not run late: the event id the bridge acks, or null with no capable bridge.
   */
  sendHomeControl(control: { button: string; until: number }): string | null {
    if (!this.current || this.features?.has("home-control") !== true) return null;
    const id = randomUUID();
    this.current.response.write(`event: home-control\nid: ${id}\ndata: ${JSON.stringify({ id, button: control.button, until: control.until })}\n\n`);
    return id;
  }

  /**
   * A late ask's question (kind "ask", key its id) or a late Ops item's: its chat and due time, which the bridge writes into its own sentence
   * for the monitor chat, under the id the bridge acks (the same for every resend of one question). False with no
   * capable bridge. Not replayed: the next sweep sends it again until a delivered ack.
   */
  sendLateAsk(id: string, ask: { kind: string; key: string; chat?: string; dueAt: string }): boolean {
    if (!this.current || this.features?.has("ask-late") !== true) return false;
    this.current.response.write(`event: late-ask\nid: ${id}\ndata: ${JSON.stringify({ id, ...ask })}\n\n`);
    return true;
  }

  seen(): void {
    this.lastSeen = Date.now();
  }

  status(): { connected: boolean; lastSeenAt: string | null } {
    return {
      connected: this.current !== null || (this.droppedAt !== null && Date.now() - this.droppedAt < OFFLINE_GRACE_MS),
      lastSeenAt: this.lastSeen === null ? null : new Date(this.lastSeen).toISOString(),
    };
  }

  detach(): void {
    if (!this.current) return;
    const { response, ping } = this.current;
    clearInterval(ping);
    this.current = null;
    response.end();
  }
}
