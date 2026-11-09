/**
 * Web push. One user, so every subscription is
 * yours; a push goes to all of them. With no VAPID keys the service is inert
 * and every send reports "unconfigured".
 */

import webpush from "web-push";
import { z } from "zod";

import { ASK, canApprove, GOT_IT, isGotIt, isTodo, MERGE_READY, optionNeedsText, PLAN, threadKey, UPDATE, wantsText } from "../shared/answers.js";
import type { Need, PushAction, PushActionId, PushAnswer, PushConfigResponse, PushRemoval } from "../shared/board.js";
import { UPDATES_ID } from "../shared/conversations.js";
import type { VapidConfig } from "./config.js";
import { needRev } from "./http.js";
import { digestPayload, withUnsent } from "./quiet.js";
import { MAX_PUSH_SUBSCRIPTIONS, pushHost, type PushSubscriptionRow, type Store } from "./store.js";
import { APP_NAME, RIVET_NAME, rivetWords } from "../shared/names.js";

/**
 * The SSRF boundary, checked when a subscription is stored and again before a
 * send: a browser's push service picks the endpoint, so it is always one of
 * these hosts or a subdomain of one.
 */
export const PUSH_ENDPOINT_HOSTS = [
  "push.apple.com",
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.microsoft.com",
] as const;

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_ENDPOINT_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

const base64url = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+=*$/);

export const subscriptionSchema = z.object({
  endpoint: z.string().max(2000).refine(isPushEndpoint, "not a push service endpoint"),
  keys: z.object({ p256dh: base64url(200), auth: base64url(100) }),
});

export const unsubscribeSchema = z.object({ endpoint: z.string().max(2000) });

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  /** Same-origin path the notification opens. */
  path: string;
  /** Unset means needs-you: a push held by an earlier build has none. */
  level?: PushLevel;
  /** The card or chat it is about: the service worker drops a push for what you are looking at. */
  card?: string;
  chat?: string;
  /** The conversation a Rivet message is in. */
  conversation?: string;
  /** The card's rev when the push was made: a button's answer carries it, so a tap after the card changed is refused (409). */
  rev?: string;
  /** The notification's buttons, and what each answering one sends. */
  actions?: PushAction[];
  answers?: Partial<Record<PushActionId, PushAnswer>>;
}

/** Needs you: sound and vibration. FYI: a silent notification at low urgency that never breaks quiet hours. */
export type PushLevel = "needs-you" | "fyi";

/** A card's level by kind. A kind not listed needs you, so nothing important goes quiet by accident. */
export const KIND_LEVELS: ReadonlyMap<string, PushLevel> = new Map([
  ["approval", "needs-you"],
  ["decision", "needs-you"],
  ["question", "needs-you"],
  ["todo", "needs-you"],
  ["risk", "needs-you"],
  [ASK, "needs-you"],
  [MERGE_READY, "needs-you"],
  [PLAN, "needs-you"],
  ["merged", "fyi"],
  ["shipped", "fyi"],
  ["briefing", "fyi"],
  ["info", "fyi"],
  [UPDATE, "fyi"],
]);

/** An update card is always quiet; on any other card its own `push` wins, then a risk tag, then its kind. */
export function needLevel(need: Need): PushLevel {
  if (need.kind === UPDATE) return "fyi";
  return need.push ?? (need.risk ? "needs-you" : (KIND_LEVELS.get(need.kind) ?? "needs-you"));
}

export interface PushOptions {
  TTL: number;
  urgency: "high" | "low";
}

/** An FYI is on the board anyway, so a phone that was offline for hours does not need it. */
export const PUSH_OPTIONS: Record<PushLevel, PushOptions> = {
  "needs-you": { TTL: 24 * 60 * 60, urgency: "high" },
  fyi: { TTL: 6 * 60 * 60, urgency: "low" },
};

export interface PushSender {
  /** Resolves with the push service's HTTP status. */
  send(subscription: PushSubscriptionRow, payload: string, options: PushOptions): Promise<number>;
}

export interface PushReport {
  sent: number;
  removed: number;
  /** "duplicate": a push with this key was already held or sent. */
  skipped?: "unconfigured" | "no-subscriptions" | "quiet" | "duplicate";
}

/** What a push is about; quiet hours hold every category but the ones you let through. */
export type PushCategory = "card" | "app-down" | "deploy-failed" | "briefing" | "test";

/** The categories whose failed immediate push is kept for the digest retry: they have no outbox of their own. */
export type RetryCategory = "card";

/** The level of a push whose payload names none. */
export const CATEGORY_LEVELS: Record<PushCategory, PushLevel> = {
  card: "needs-you",
  "app-down": "needs-you",
  "deploy-failed": "needs-you",
  briefing: "fyi",
  test: "needs-you",
};

/** Selected held pushes, overflow count, and ops alerts pruned unsent. */
export interface HeldBatch {
  upTo: number;
  /** Exact rows selected; a breakthrough retry can leave quiet pushes between them. */
  ids: number[];
  payloads: PushPayload[];
  /** The keys of the held pushes in the batch; a push held without one has none. */
  keys: string[];
  /** The keyed held pushes' text, by key, for a digest reword hook. */
  bodies: HeldBody[];
  dropped: number;
  unsent: number;
}

/** A held push's text by its key: what a digest reword hook reads, and returns to say it again. */
export interface HeldBody {
  key: string;
  body: string;
}

/** Quiet hours and durable retries (quiet.ts). The service asks it before every send. */

export interface PushGate {
  holds(category: PushCategory, now: Date, level: PushLevel): boolean;
  /**
   * Holds a push, recording `key` and adding `unsent` to the digest in the same step; nothing when the key is already recorded.
   * Returns the keys of older held pushes pruned for room, which are never sent.
   */
  hold(payload: PushPayload, now: Date, key?: string, unsent?: number, retryCategory?: RetryCategory): string[];
  lastHeldId(): number;
  /** Retires older held notifications replaced by a successful send with this tag. */
  supersede(tag: string, through: number, level: PushLevel): string[];
  /** Takes held pushes out unsent, by key, their keys released; returns the keys it took. */
  withdraw(keys: readonly string[]): string[];
  /** Rewrites a held push's text, by key, in its place, its level and the rest kept; false when none is held under it. */
  reword(key: string, body: string): boolean;
  /** Eligible held pushes, oldest first; a failed breakthrough cap can retry during quiet hours. */
  releasable(now: Date): HeldBatch | null;
  /** Removes a delivered batch or schedules a retry; true when the gate gave up on it. */
  settle(batch: HeldBatch, delivered: boolean, now: Date): boolean;
  hasKey(key: string): boolean;
  markSent(key: string, now: Date): void;
}

/** A board PUT pushes at most this many notifications; past it the last one sums up the rest. */
export const MAX_PUSHES_PER_BOARD = 5;
const TITLE_MAX = 80;
const BODY_MAX = 140;
const GONE = new Set([404, 410]);

const FLAVOUR = [
  `${RIVET_NAME} is waiting for your word.`,
  `${RIVET_NAME} has one card that needs you.`,
  `${RIVET_NAME} has one for you.`,
];

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Needs in `next` whose id was not in `previous`, in board order. */
export function newNeeds(previous: readonly Pick<Need, "id">[] | null, next: readonly Need[]): Need[] {
  const before = new Set((previous ?? []).map((need) => need.id));
  return next.filter((need) => !before.has(need.id));
}

/** The one option labelled one of `labels` (any case) that needs no typed note, or none. */
function optionCalled(need: Need, labels: readonly string[]): string | undefined {
  const wanted = new Set(labels.map((label) => label.toLowerCase()));
  const named = need.options?.filter((option) => wanted.has(option.label.trim().toLowerCase())) ?? [];
  return named.length === 1 && !optionNeedsText(need, named[0]!.label) ? named[0]!.label : undefined;
}

/**
 * A card's notification buttons, or none where one tap must not answer it: a risk card (its yes needs the card's
 * confirm), a todo card, a card answered by typing, and an option card with no Yes option. Yes approves or picks the Yes
 * option; no picks the No option, or else opens the card, since a reject always asks why first. An
 * update card has Seen alone, a Got it card Got it alone.
 */
export function pushButtons(need: Need): Pick<PushPayload, "actions" | "answers"> {
  if (need.kind === UPDATE) return { actions: [{ action: "seen", title: "Seen" }], answers: { seen: { decision: "seen" } } };
  if (isGotIt(need)) return { actions: [{ action: "yes", title: GOT_IT }], answers: { yes: { decision: "choice", choice: GOT_IT } } };
  if (need.risk || isTodo(need) || wantsText(need)) return {};
  let yes: PushAnswer;
  let no: PushAnswer | undefined;
  if (need.options?.length) {
    const yesOption = optionCalled(need, ["Yes"]);
    if (!yesOption) return {};
    const noOption = optionCalled(need, ["No"]);
    yes = { decision: "choice", choice: yesOption };
    no = noOption ? { decision: "choice", choice: noOption } : undefined;
  } else if (canApprove(need)) {
    yes = { decision: "approve" };
    no = undefined;
  } else return {};
  return {
    // Android Chrome shows two buttons, so Later falls off there; swiping the notification away is Later.
    actions: [
      { action: "yes", title: "Yes" },
      { action: "no", title: "No" },
      { action: "later", title: "Later" },
    ],
    answers: no ? { yes, no } : { yes },
  };
}

export function cardPayload(need: Need, index = 0): PushPayload {
  // One notification per thread, each replacing the last: the tag is the thread's.
  if (need.kind === UPDATE) {
    const head = [need.tag, need.thread].filter(Boolean).join(" · ");
    return {
      title: clip(need.title, TITLE_MAX),
      body: clip([head, need.ask?.trim()].filter(Boolean).join(". "), BODY_MAX),
      tag: `thread-${threadKey(need.thread)}`,
      path: `/?card=${encodeURIComponent(need.id)}`,
      level: "fyi",
      card: need.id,
      rev: needRev(need),
      ...pushButtons(need),
    };
  }
  const risk = need.risk ? `${need.risk[0]!.toUpperCase()}${need.risk.slice(1)} change. ` : "";
    const ask = need.ask?.trim() ? need.ask : FLAVOUR[index % FLAVOUR.length]!;
  return {
    title: clip(need.title, TITLE_MAX),
    body: clip(`${risk}${ask}`, BODY_MAX),
    tag: `need-${need.id}`,
    path: `/?card=${encodeURIComponent(need.id)}`,
    level: needLevel(need),
    card: need.id,
    rev: needRev(need),
    ...pushButtons(need),
  };
}

/** One push per new card, capped; past the cap the last one counts the rest. Each with the cards it stands for. */
export function boardPushes(fresh: readonly Need[]): { payload: PushPayload; needs: Need[] }[] {
  // Several new update cards in one thread are one notification, the last one's: each would replace the one before.
  const last = new Map(fresh.filter((need) => need.kind === UPDATE).map((need) => [threadKey(need.thread), need]));
  const added = fresh.filter((need) => need.kind !== UPDATE || last.get(threadKey(need.thread)) === need);
  const one = (need: Need, index: number) => ({ payload: cardPayload(need, index), needs: [need] });
  if (added.length <= MAX_PUSHES_PER_BOARD) return added.map(one);
  const shown = added.slice(0, MAX_PUSHES_PER_BOARD - 1).map(one);
  const rest = added.slice(shown.length);
  const level = rest.some((need) => needLevel(need) === "needs-you") ? "needs-you" : "fyi";
  return [
    ...shown,
    { payload: { title: `${rest.length} more cards`, body: `${RIVET_NAME} has more cards for you.`, tag: "needs-more", path: "/", level }, needs: rest },
  ];
}

export function boardPayloads(fresh: readonly Need[]): PushPayload[] {
  return boardPushes(fresh).map(({ payload }) => payload);
}

const SUMMARY_PUSH_PREFIX = "cards:";

/**
 * A "more cards" summary's push key: the keys of the cards it counts, when each card has one, so a held summary is
 * checked again before the digest like a card's own push. Undefined when any card has none.
 */
export function summaryPushKey(keys: readonly (string | undefined)[]): string | undefined {
  return keys.length > 0 && keys.every((key) => key !== undefined) ? `${SUMMARY_PUSH_PREFIX}${JSON.stringify(keys)}` : undefined;
}

/** The card keys a summary's push key counts; none for any other key. */
export function summaryKeys(key: string): string[] {
  if (!key.startsWith(SUMMARY_PUSH_PREFIX)) return [];
  try {
    const keys: unknown = JSON.parse(key.slice(SUMMARY_PUSH_PREFIX.length));
    return Array.isArray(keys) && keys.every((one) => typeof one === "string") ? keys : [];
  } catch {
    return [];
  }
}

/** Keys as the digest listeners see them: a summary's with the keys of the cards it counts. */
function withSummarised(keys: readonly string[]): string[] {
  return keys.flatMap((key) => [key, ...summaryKeys(key)]);
}

/**
 * A Rivet chat message's push, about its conversation: titled after it, collapsing only with that
 * conversation's own pushes, opening on it. Updates is FYI unless Rivet asks something. `chat` names the conversation,
 * as the app reports the one on screen, so only a push for that one is held back. One with no conversation says
 * "rivet", which no app reports any more: it always shows.
 */
export function rivetPayload(text: string, conversation?: { id: string; title: string | null }): PushPayload {
  const body = clip(text, BODY_MAX);
  if (!conversation) return { title: RIVET_NAME, body, tag: "rivet-chat", path: "/?tab=chat", chat: "rivet" };
  const updates = conversation.id === UPDATES_ID;
  return {
    title: conversation.title ?? RIVET_NAME,
    body,
    tag: `conv-${conversation.id}`,
    path: `/?conversation=${encodeURIComponent(conversation.id)}`,
    chat: conversation.id,
    conversation: conversation.id,
    ...(updates && !/\?\s*$/.test(text) ? { level: "fyi" as const } : {}),
  };
}

export const TEST_PAYLOAD: PushPayload = {
  title: APP_NAME,
  body: `Hi! ${RIVET_NAME} will ping you here when a card needs you.`,
  tag: "rivet-test",
  path: "/",
};

function webPushSender(vapid: VapidConfig): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return {
    async send(subscription, payload, options) {
      try {
        return (await webpush.sendNotification(subscription, payload, options)).statusCode;
      } catch (error) {
        if (error instanceof webpush.WebPushError) return error.statusCode;
        throw error;
      }
    },
  };
}

export class PushService {
  readonly publicKey: string | null;
  private readonly sender: PushSender | null;
  private flushing: Promise<PushReport | null> | null = null;
  private readonly digestListeners: ((delivered: boolean, keys: readonly string[]) => void)[] = [];
  private readonly releaseChecks: ((keys: readonly string[]) => readonly string[])[] = [];
  private readonly rewords: ((held: readonly HeldBody[]) => readonly HeldBody[])[] = [];
  private lead: (() => number) | null = null;

  constructor(
    private readonly store: Store,
    vapid: VapidConfig | null,
    private readonly logger: Pick<Console, "error">,
    sender?: PushSender,
    readonly gate: PushGate | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {
    let resolved = sender ?? null;
    if (!resolved && vapid) {
      try {
        resolved = webPushSender(vapid);
      } catch {
        logger.error("[push] VAPID settings are invalid; push is off");
      }
    }
    this.sender = resolved;
    this.publicKey = resolved && vapid ? vapid.publicKey : null;
  }

  get configured(): boolean {
    return this.sender !== null;
  }

  async notifyNewNeeds(added: readonly Need[], keyOf: (need: Need) => string | undefined = () => undefined): Promise<PushReport> {
    const total: PushReport = { sent: 0, removed: 0 };
    if (added.length === 0) return total;
    let held = 0;
    // A card's own push may carry a key (keyOf), so one quiet hours held is checked again before the digest: an update
    // card's push is its thread's, the last new one there, as boardPushes shows it. A "more cards" summary carries its
    // cards' keys when each has one.
    for (const { payload, needs } of boardPushes(added)) {
      const key = needs.length === 1 ? keyOf(needs[0]!) : summaryPushKey(needs.map(keyOf));
      const report = await this.deliver(payload, "card", key);
      if (report.skipped === "quiet") held += 1;
      // A keyed card already pushed or held (one put back on the board) skips only itself.
      else if (report.skipped === "duplicate") continue;
      else if (report.skipped) return report;
      total.sent += report.sent;
      total.removed += report.removed;
    }
    return held && !total.sent ? { ...total, skipped: "quiet" } : total;
  }

  /**
   * Any other push (ops alerts, briefings): the same sender, under the same quiet hours.
   * With a key, a push already held or sent under it is skipped as a duplicate.
   * `unsent` pruned ops alerts are stated in the push, or in the digest when quiet hours hold it.
   */
  notify(payload: PushPayload, category: Exclude<PushCategory, "test">, key?: string, unsent = 0): Promise<PushReport> {
    return this.deliver(payload, category, key, unsent);
  }

  /** Stores this phone's subscription; any the cap pushes out are logged like every other removal. */
  subscribe(subscription: PushSubscriptionRow): void {
    for (const removal of this.store.addPushSubscription(subscription, this.now())) this.logRemoval(removal);
    this.logger.error(`[push] a phone signed up (${pushHost(subscription.endpoint)}); ${this.store.countPushSubscriptions()} now`);
  }

  /** Settings turned this phone off; true when the server held it. */
  unsubscribe(endpoint: string): boolean {
    const removal = this.store.removePushSubscription(endpoint, "turned-off", null, this.now());
    if (removal) this.logRemoval(removal);
    return removal !== null;
  }

  /** What the app needs to subscribe, and whether any phone can be reached at all. */
  health(): PushConfigResponse {
    return {
      configured: this.configured,
      publicKey: this.publicKey,
      subscriptions: this.store.countPushSubscriptions(),
      lastRemoval: this.store.listPushRemovals(1)[0] ?? null,
    };
  }

  /** Every removal is logged with its reason, the status and the push service's host, never the endpoint; the last one loudly. */
  private logRemoval(removal: PushRemoval): void {
    const why =
      removal.reason === "gone" ? `${removal.host} answered ${removal.status}` : removal.reason === "cap" ? `oldest past ${MAX_PUSH_SUBSCRIPTIONS} phones` : "turned off in Settings";
    this.logger.error(`[push] removed a phone (${why}); ${removal.remaining} left`);
    if (removal.remaining === 0) this.logger.error("[push] ALERT notifications are off on every phone");
  }

  sendTest(): Promise<PushReport> {
    return this.deliver(TEST_PAYLOAD, "test");
  }

  /**
   * Sends one digest of eligible held pushes; null when nothing is ready.
   * The held pushes stay in the gate until a send reaches a device, so a failure retries.
   */
  flushHeld(): Promise<PushReport | null> {
    if (!this.gate) return Promise.resolve(null);
    this.flushing ??= this.flushOnce(this.gate).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushOnce(gate: PushGate): Promise<PushReport | null> {
    let batch = gate.releasable(this.now());
    if (!batch) return null;
    // A held push whose news no longer holds (an ops alert someone has since taken on) leaves the digest unsent;
    // a summary leaves when every card it counts would.
    const asked = withSummarised(batch.keys);
    const out = new Set(
      this.releaseChecks.flatMap((check) => {
        try {
          return check(asked);
        } catch (error) {
          this.logger.error(`[push] digest check failed: ${error instanceof Error ? error.message : "error"}`);
          return [];
        }
      }),
    );
    const stale = batch.keys.filter((key) => {
      const cards = summaryKeys(key);
      return out.has(key) || (cards.length > 0 && cards.every((card) => out.has(card)));
    });
    if (stale.length) {
      const withdrawn = gate.withdraw(stale);
      if (withdrawn.length) this.settled(false, withdrawn);
    }
    // One whose news holds in part (a briefing naming a break someone has since taken on) is said calmly.
    // Each hook reads the text as held, so one reworded calmly and then owned no more is said again as it stands.
    const held = batch.bodies.filter(({ key }) => !stale.includes(key));
    const bodies = new Map(held.map(({ key, body }) => [key, body]));
    let reworded = false;
    for (const reword of this.rewords) {
      try {
        for (const { key, body } of reword(held)) {
          if (bodies.has(key) && bodies.get(key) !== body) reworded = gate.reword(key, body) || reworded;
        }
      } catch (error) {
        this.logger.error(`[push] digest reword failed: ${error instanceof Error ? error.message : "error"}`);
      }
    }
    if (stale.length || reworded) {
      batch = gate.releasable(this.now());
      if (!batch) return null;
    }
    let needs: number | undefined;
    try {
      needs = this.lead?.();
    } catch (error) {
      this.logger.error(`[push] digest lead failed: ${error instanceof Error ? error.message : "error"}`);
    }
    const report = await this.send(digestPayload(batch.payloads, batch.dropped, batch.unsent, needs));
    const delivered = report.sent > 0;
    const gaveUp = gate.settle(batch, delivered, this.now());
    if (gaveUp) this.logger.error("[push] gave up on the quiet-hours digest after repeated failures");
    if (delivered || gaveUp) this.settled(delivered, batch.keys);
    return report;
  }

  private settled(delivered: boolean, keys: readonly string[]): void {
    const all = withSummarised(keys);
    for (const listener of this.digestListeners) listener(delivered, all);
  }

  /**
   * Asked with the keys of the held pushes before a digest goes; the keys it returns are withdrawn unsent, settled as
   * never sent (onDigestSettled). Returns the removal.
   */
  onDigestRelease(check: (keys: readonly string[]) => readonly string[]): () => void {
    this.releaseChecks.push(check);
    return () => {
      const at = this.releaseChecks.indexOf(check);
      if (at >= 0) this.releaseChecks.splice(at, 1);
    };
  }

  /** Asked as a digest goes how many cards need you now (the summary's needsYou), which its text opens with. Returns the removal. */
  onDigestLead(needs: () => number): () => void {
    this.lead = needs;
    return () => {
      if (this.lead === needs) this.lead = null;
    };
  }

  /**
   * Asked with the held pushes' text, by key, before a digest goes; each text it returns replaces the one held under its
   * key. Returns the removal.
   */
  onDigestReword(reword: (held: readonly HeldBody[]) => readonly HeldBody[]): () => void {
    this.rewords.push(reword);
    return () => {
      const at = this.rewords.indexOf(reword);
      if (at >= 0) this.rewords.splice(at, 1);
    };
  }

  /**
   * Called with the keys of held pushes once they are settled (a summary's with its cards' keys): delivered in a digest, or never sent because the digest
   * was given up on, they were pruned from the hold for room, or withdrawn before it went. Returns the removal.
   */
  onDigestSettled(listener: (delivered: boolean, keys: readonly string[]) => void): () => void {
    this.digestListeners.push(listener);
    return () => {
      const at = this.digestListeners.indexOf(listener);
      if (at >= 0) this.digestListeners.splice(at, 1);
    };
  }

  private async deliver(payload: PushPayload, category: PushCategory, key?: string, unsent = 0): Promise<PushReport> {
    if (!this.sender) return { sent: 0, removed: 0, skipped: "unconfigured" };
    if (key && this.gate?.hasKey(key)) return { sent: 0, removed: 0, skipped: "duplicate" };
    const leveled = { ...payload, level: payload.level ?? CATEGORY_LEVELS[category] };
    const heldThrough = this.gate?.lastHeldId() ?? 0;
    if (this.gate && category !== "test") {
      const now = this.now();
      if (this.gate.holds(category, now, leveled.level)) {
        const pruned = this.gate.hold(leveled, now, key, unsent);
        if (pruned.length) this.settled(false, pruned);
        return { sent: 0, removed: 0, skipped: "quiet" };
      }
      await this.flushHeld();
    }
    const report = await this.send(withUnsent(leveled, unsent));
    // Cards (chat lines included) have no outbox of their own. Keep a failed immediate push for the durable digest retry.
    // A partial success needs no replay, and removed phones must not leave a stale ping.
    if (this.gate && category === "card" && report.sent === 0 && !report.skipped && this.store.countPushSubscriptions() > 0) {
      const pruned = this.gate.hold(leveled, this.now(), key, unsent, category);
      if (pruned.length) this.settled(false, pruned);
    }
    if (this.gate && report.sent > 0 && category === "card") {
      const superseded = this.gate.supersede(leveled.tag, heldThrough, leveled.level);
      if (superseded.length) this.settled(false, superseded);
    }
    if (key && report.sent > 0) this.gate?.markSent(key, this.now());
    return report;
  }

  private async send(payload: PushPayload): Promise<PushReport> {
    if (!this.sender) return { sent: 0, removed: 0, skipped: "unconfigured" };
    const subscriptions = this.store.listPushSubscriptions();
    if (subscriptions.length === 0) return { sent: 0, removed: 0, skipped: "no-subscriptions" };
    const level = payload.level ?? "needs-you";
    // Card and conversation titles carry agent-written words; a notification shows the old name as Rivet.
    const body = JSON.stringify({ ...payload, title: rivetWords(payload.title), body: rivetWords(payload.body), level, silent: level === "fyi" });
    let sent = 0;
    let removed = 0;
    for (const subscription of subscriptions) {
      if (!isPushEndpoint(subscription.endpoint)) continue;
      try {
        const status = await this.sender.send(subscription, body, PUSH_OPTIONS[level]);
        if (GONE.has(status)) {
          const removal = this.store.removePushSubscription(subscription.endpoint, "gone", status, this.now());
          if (removal) this.logRemoval(removal);
          removed += 1;
        } else if (status >= 200 && status < 300) {
          sent += 1;
        } else {
          this.logger.error(`[push] push service answered ${status}`);
        }
      } catch (error) {
        this.logger.error(`[push] send failed: ${error instanceof Error ? error.message : "error"}`);
      }
    }
    return { sent, removed };
  }
}
