import { z } from "zod";

import { CARD_CHECKER_ID, cardCheckerSchema, DEFAULT_CARD_CHECKER } from "./card-check.js";
import { CHAT_CAPS, CHAT_IDLE_MINUTES, CHAT_NIGHTLY, CHATS_ID, chatsSchema, DEFAULT_CHATS } from "./chats.js";
import { chatSendDelaySchema, DEFAULT_CHAT_SEND_DELAY } from "./command.js";
import { DEFAULT_READER_FIX_CAP, minutesWords, READER_FIX_CAPS, readerBehaviourId, READERS, READERS_FIX_ID, type ReaderSpec } from "./readers.js";

// Settings › Behaviours, which the owner asked for to adjust and toggle each of these in one place: every
// behaviour the agent runs by itself, in one list. Rows only the owner's version has live in behaviours-extra.ts,
// which the public export leaves out; nothing imports it by name (server/behaviours.ts reads it when present).

export const BEHAVIOUR_GROUPS = ["Versions", "Chat", "Work", "Ops", "Limits", "Alerts", "Yours only"] as const;
export type BehaviourGroup = (typeof BEHAVIOUR_GROUPS)[number];

/**
 * - `live`: stored here and honoured.
 * - `always-on`: shown, with no switch yet.
 * - `linked`: set in a Settings section, which the row opens.
 * - `endpoint`: another route owns the value; the row reads and writes it there.
 * - `switch`: a file on the Mac is the value; the bridge writes it and reports it, and the row shows the report.
 * - `report`: nothing to set; the row shows what the bridge last reported.
 */
export type BehaviourControl = "live" | "always-on" | "linked" | "endpoint" | "switch" | "report";

/** A `report` row's words: its summary, and the detail under it when there is one. */
export interface RowReport {
  note: string;
  detail: string | null;
}

/**
 * A switch row's file as the bridge last reported it: `offline` with no report from a connected bridge, `absent` (on),
 * `ours` (paused from this tab), `other` (paused by other words, its first line shown) or `stopped` by the alarm.
 */
export type SwitchState = { state: "offline" } | { state: "absent" } | { state: "ours" } | { state: "other"; line: string } | { state: "stopped" };

/** The Settings sections a linked row opens. */
export type BehaviourSection = "models" | "quiet" | "push" | "voice";

export type BehaviourValue = Record<string, unknown>;

/** A knob the tab sets with a select, under its row. */
export interface BehaviourSelect {
  knob: string;
  label: string;
  choices: readonly { value: string | number; label: string }[];
}

export interface Behaviour {
  id: string;
  group: BehaviourGroup;
  name: string;
  /** One plain line saying what it does. */
  line: string;
  scope: "all" | "private";
  control: BehaviourControl;
  knobs: z.ZodType<BehaviourValue>;
  default: BehaviourValue;
  /** The knob chip the row shows, from its value. */
  chip?: (value: BehaviourValue) => string;
  link?: BehaviourSection;
  endpoint?: string;
  /** Shown in place of the switch, for a row set somewhere else in the app. */
  note?: string;
  selects?: readonly BehaviourSelect[];
  /** The boolean knob a `live` row's switch sets, when it is not `on`; its selects stay settable while it is off. */
  switchKey?: string;
  /** A `live` row whose value under `key` is one pick of a few, shown as a select. */
  choices?: BehaviourChoices;
  /**
   * How the app shows or sends a chat, and nothing the agent does by itself. A row without it is one a session a
   * device code alone made cannot set (routes/behaviours.ts), so a new row is closed to it until this says otherwise.
   */
  preference?: true;
}

export interface BehaviourChoices {
  key: string;
  /** The select's name, read aloud; the row's name when absent. */
  label?: string;
  options: readonly { value: string | number; label: string }[];
  /** The select sits beside the row's on and off switch (a reader's freshness); without it, in place of the switch. */
  switch?: boolean;
}

/** Keeps each entry's chip typed by its own knobs. */
export function behaviour<S extends z.ZodType<BehaviourValue>>(entry: Omit<Behaviour, "knobs" | "default" | "chip"> & { knobs: S; default: z.infer<S>; chip?: (value: z.infer<S>) => string }): Behaviour {
  return entry as Behaviour;
}

const onOff = z.object({ on: z.boolean() }).strict();
const noKnobs = z.object({}).strict();

type Plain = Pick<Behaviour, "id" | "group" | "name" | "line"> & Partial<Pick<Behaviour, "scope" | "note">>;

/** A behaviour that runs with no switch in the tab yet. */
export const alwaysOn = (entry: Plain): Behaviour => behaviour({ scope: "all", ...entry, control: "always-on", knobs: onOff, default: { on: true } });

export const linked = (entry: Plain & { link: BehaviourSection }): Behaviour => behaviour({ scope: "all", ...entry, control: "linked", knobs: noKnobs, default: {} });

const oneOf = (values: readonly number[]) => z.number().refine((value) => values.includes(value));

/** A reader's row: its on/off and how fresh its reading must be (server/ops/readers.ts). */
export function readerBehaviour(spec: ReaderSpec, scope: Behaviour["scope"] = "all"): Behaviour {
  const label = (minutes: number) => `fresh ${minutesWords(minutes)}`;
  return behaviour({
    id: readerBehaviourId(spec.id),
    group: "Ops",
    name: spec.name,
    line: spec.line,
    scope,
    control: "live",
    knobs: z.object({ on: z.boolean(), fresh: oneOf(spec.fresh) }).strict(),
    default: { on: true, fresh: spec.defaultFresh },
    chip: (value) => label(value.fresh),
    choices: { key: "fresh", switch: true, label: `${spec.name} freshness`, options: spec.fresh.map((minutes) => ({ value: minutes, label: label(minutes) })) },
  });
}
export const CHAT_SEND_DELAY_PATH = "/api/settings/chat-send-delay";
export const REPLY_STYLE_ID = "chat.reply-style";
export const TEXT_SIZE_ID = "chat.text-size";

export const PROMISE_KEEPER_ID = "work.promise-keeper";
/** The most minutes ahead the Promise keeper can warn: two hours. */
export const PROMISE_WARN_MAX = 120;
export const promiseKeeperSchema = z.object({ on: z.boolean(), warnMinutes: z.number().int().min(1).max(PROMISE_WARN_MAX) }).strict();
export type PromiseKeeper = z.infer<typeof promiseKeeperSchema>;
export const DEFAULT_PROMISE_KEEPER: PromiseKeeper = { on: true, warnMinutes: 15 };

const blockOrWarn = [
  { value: "block", label: "Block" },
  { value: "warn", label: "Warn" },
] as const;

export const cardCheckerBehaviour = behaviour({
  id: CARD_CHECKER_ID,
  group: "Work",
  name: "Card checker",
  line: "Checks every card before it posts",
  scope: "all",
  control: "live",
  knobs: cardCheckerSchema,
  default: DEFAULT_CARD_CHECKER,
  selects: [
    { knob: "shape", label: "Heading and 3 bullets", choices: blockOrWarn },
    { knob: "options", label: "Every option pictured", choices: blockOrWarn },
    { knob: "stills", label: "Stills 1600 px or less", choices: blockOrWarn },
    { knob: "video", label: "Videos at the card size", choices: blockOrWarn },
    { knob: "links", label: "Private links by email", choices: blockOrWarn },
    { knob: "edge", label: "Thick coloured edge", choices: [{ value: "warn", label: "Warn" }] },
  ],
});

export const BEHAVIOURS: readonly Behaviour[] = [
  behaviour({
    id: "chat.send-delay",
    group: "Chat",
    name: "Send delay",
    line: "Seconds to cancel or edit before it sends",
    scope: "all",
    control: "endpoint",
    preference: true,
    endpoint: CHAT_SEND_DELAY_PATH,
    knobs: chatSendDelaySchema,
    default: DEFAULT_CHAT_SEND_DELAY,
    chip: (value) => `${value.seconds} s`,
  }),
  // Also picked under Chat's options button; each phone keeps a copy for the moments before the list answers
  // (web/src/views/chat-prefs.ts).
  behaviour({
    id: REPLY_STYLE_ID,
    group: "Chat",
    name: "Reply style",
    line: "How long replies are: short, normal or detailed",
    scope: "all",
    control: "live",
    preference: true,
    knobs: z.object({ style: z.enum(["short", "normal", "detailed"]) }).strict(),
    default: { style: "normal" },
    choices: { key: "style", options: [{ value: "short", label: "Short" }, { value: "normal", label: "Normal" }, { value: "detailed", label: "Detailed" }] },
  }),
  behaviour({
    id: TEXT_SIZE_ID,
    group: "Chat",
    name: "Text size",
    line: "How big the words are: small, medium or large",
    scope: "all",
    control: "live",
    preference: true,
    knobs: z.object({ size: z.enum(["s", "m", "l"]) }).strict(),
    default: { size: "m" },
    choices: { key: "size", options: [{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }] },
  }),
  linked({ id: "work.who-does-what", group: "Work", name: "Who does what", line: "Which model does each job", link: "models" }),
  // asks/promises.ts: a time a chat tells the monitor goes on its ask, and the chat is asked before it slips.
  behaviour({
    id: PROMISE_KEEPER_ID,
    group: "Work",
    name: "Promise keeper",
    line: "Puts a time a chat promises on its ask, and asks before it slips",
    scope: "all",
    control: "live",
    knobs: promiseKeeperSchema,
    default: DEFAULT_PROMISE_KEEPER,
    chip: (value) => `${value.warnMinutes} min before`,
  }),
  // The chip is the bridge's last count (routes/behaviours.ts); the count, the idle pull and the nightly pick run with
  // closing off.
  behaviour({
    id: CHATS_ID,
    group: "Work",
    name: "Chats run themselves",
    line: "Counts chats, closes finished ones, pulls backlog when idle, and picks small issues each night",
    scope: "all",
    control: "live",
    knobs: chatsSchema,
    default: DEFAULT_CHATS,
    switchKey: "close",
    selects: [
      { knob: "cap", label: "Chat cap", choices: CHAT_CAPS.map((cap) => ({ value: cap, label: `cap ${cap}` })) },
      { knob: "idleMinutes", label: "Pull backlog after idle", choices: CHAT_IDLE_MINUTES.map((minutes) => ({ value: minutes, label: `${minutes} min` })) },
      { knob: "nightly", label: "Small issues each night", choices: CHAT_NIGHTLY.map((count) => ({ value: count, label: count ? String(count) : "Off" })) },
    ],
  }),
  cardCheckerBehaviour,
  // ops/pickup.ts, ops/late.ts, ops/fixes.ts and ops/auto-clear.ts: none has a switch yet.
  alwaysOn({ id: "ops.pick-up-reds", group: "Ops", name: "Pick up unowned reds", line: "A red nobody is on gets a fix job" }),
  alwaysOn({ id: "ops.ask-late-why", group: "Ops", name: "Ask late work why", line: "Asks a late chat for its new time" }),
  alwaysOn({ id: "ops.fix-results", group: "Ops", name: "Fix-result cards", line: "Says when a red goes green" }),
  alwaysOn({ id: "ops.clear-stale", group: "Ops", name: "Clear stale records", line: "Clears records whose work ended" }),
  behaviour({
    id: READERS_FIX_ID,
    group: "Ops",
    name: "Readers fix themselves",
    line: "A stale, empty or wrong reader gets a fix job; a card only if it keeps happening",
    scope: "all",
    control: "live",
    knobs: z.object({ on: z.boolean(), cap: oneOf(READER_FIX_CAPS) }).strict(),
    default: { on: true, cap: DEFAULT_READER_FIX_CAP },
    chip: (value) => `card after ${value.cap}`,
    choices: { key: "cap", switch: true, label: "Fix jobs before a card", options: READER_FIX_CAPS.map((cap) => ({ value: cap, label: `card after ${cap}` })) },
  }),
  ...READERS.map((spec) => readerBehaviour(spec)),
  // Quiet hours is in behaviours-extra.ts: the public Settings has no quiet section to open.
  linked({ id: "alerts.push", group: "Alerts", name: "Push notifications", line: "Pings this phone when a card lands", link: "push" }),
  linked({ id: "alerts.voice", group: "Alerts", name: "Voice", line: "Reads replies aloud", link: "voice" }),
];

/** One row of GET /api/behaviours: the entry without its schema, and its value now. */
export interface BehaviourRow extends Omit<Behaviour, "knobs" | "default" | "chip"> {
  /** Null on an `endpoint` row: its own route holds the value, and the list never guesses it. */
  value: BehaviourValue | null;
  chip: string | null;
  /** Null while the default stands. */
  updatedAt: string | null;
  /** A `switch` row's reported file. */
  switch?: SwitchState;
  /** A `report` row's words. */
  report?: RowReport;
  /** On a switch tap's answer: what the Mac did, which the reported file may already have moved on from. */
  done?: SwitchDone;
}

export type SwitchDone = "paused" | "already-paused" | "resumed" | "already-on" | "paused-then-stopped";

export interface BehavioursResponse {
  behaviours: BehaviourRow[];
}
