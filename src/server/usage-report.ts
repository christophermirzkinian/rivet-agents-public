import { DECISION } from "../shared/answers.js";
import {
  FOLD_IDS,
  LISTED_IDS,
  RETIRE_CARDS_A_WEEK,
  RETIRE_CARDS_FROM,
  REWORK_MIN_TIMES,
  REWORK_QUICK_MS,
  REWORK_UNDO_MS,
  REWORK_UNDO_SHARE,
  UNDO_IDS,
  USAGE_ASK_HIDES_DAYS,
  USAGE_WINDOW_DAYS,
  type UsageAsk,
  type UsageDevice,
  type UsageFeature,
  type UsageId,
  type UsageReport,
  type UsageRework,
  type UsageRow,
  reworkWords,
  usageArea,
  usageStatus,
} from "../shared/usage-ids.js";
import { localDay } from "../shared/when.js";
import { localAt, localWeekday, MORNING_HOUR } from "./morning.js";
import type { Store, UsageAskRow, UsageEventRow } from "./store.js";

// What you used: what was used in the last 30 days, counted when the page asks, from one read of
// usage_events; and the Retire? and Rework? cards it and the Monday pass send. Nothing is ever removed here: an answer
// goes to Rivet like any card's, and only Keep changes anything on this server (the id is off Retire? for 90 days).

const DAY_MS = 24 * 60 * 60 * 1000;
const OFTEN = 10;
const RARELY_MAX = 3;
const DEVICE_WORDS: Record<UsageDevice, string> = { phone: "phone", desktop: "computer" };

/** When recording began (the first event kept, by its local day) and the full days since; null with none. */
export function recording(first: string | null, now: Date): { since: string; start: number; recorded: number } | null {
  if (!first) return null;
  const start = Date.parse(first);
  return { since: localDay(start), start, recorded: Math.max(0, Math.floor((now.getTime() - start) / DAY_MS)) };
}

/** Each id's latest ask in the last 90 days: "kept" when you said Keep. */
function askedOf(asks: readonly UsageAskRow[], now: Date): Map<string, "asked" | "kept"> {
  const from = now.getTime() - USAGE_ASK_HIDES_DAYS * DAY_MS;
  const asked = new Map<string, "asked" | "kept">();
  for (const ask of asks) {
    if (Date.parse(ask.answeredAt ?? ask.at) < from) continue;
    asked.set(ask.ctl, ask.answer === "Keep" ? "kept" : "asked");
  }
  return asked;
}

/** The tabs' own screens: the base the recorder (web/src/usage.ts screenMoved) names under any sheet. */
const TAB_SCREENS = new Set(["floor", "progress", "cards", "answered", "chat", "more"]);
/** The tabs a phone's sheet left showing as it closed; the Floor it closed onto is where you then were. */
const FLASHED_TABS = new Set(["cards", "answered", "chat", "more"]);
/**
 * A copy of an event this close after the one it repeats is the same event recorded again (27 Oct: 3 copies within
 * 14 ms, and within 434 ms); it is the answer's tap lock, so two real answers are never this close. A screen's copy
 * may come later still: a new visit with the very same ms takes that long.
 */
const COPY_MS = 450;
/** A tab screen whose time began as a sheet left, this short and untapped, was never seen: see readable(). */
const FLASH_MS = 1500;
/** How far apart a sheet's leave and the next screen's start may read (each event's time is set as its batch lands). */
const JOIN_MS = 100;

/**
 * The events as they were used, read from the stored ones and never changing them (27 Oct, the first hour's real
 * events). An early recorder logged two things you never did:
 * - an event recorded 2 or 3 times (same device, kind, id, screen and value, within 450 ms of the one kept or that screen's time);
 * - a tab you never saw on the phone: closing Rivet's pane on the Floor left the Chat tab under it for about 600 ms, and closing
 *   Decide the Cards tab for up to 400 ms. Such a visit's time began the moment the sheet left (a tab you were on before
 *   the sheet also counts its time before it), it was under 1.5 s and nothing was tapped in it.
 */
export function readable(events: readonly UsageEventRow[]): UsageEventRow[] {
  const copies = new Map<string, number>();
  const lastScreen = new Map<UsageDevice, UsageEventRow>();
  const tappedOn = new Map<UsageDevice, Set<string>>();
  const kept: UsageEventRow[] = [];
  for (const event of events) {
    const at = Date.parse(event.at);
    const key = `${event.device}|${event.kind}|${event.ctl}|${event.screen}|${event.value}`;
    const seen = copies.get(key);
    if (seen !== undefined && at - seen <= Math.max(COPY_MS, event.kind === "screen" ? event.value : 0)) continue;
    copies.set(key, at);
    if (event.kind === "tap") tappedOn.get(event.device)?.add(event.screen);
    if (event.kind === "screen" && event.ctl === event.screen) {
      const before = lastScreen.get(event.device);
      const flash =
        before !== undefined &&
        event.device === "phone" &&
        FLASHED_TABS.has(event.ctl) &&
        !TAB_SCREENS.has(before.ctl) &&
        event.value < FLASH_MS &&
        Math.abs(at - event.value - Date.parse(before.at)) <= JOIN_MS &&
        !tappedOn.get(event.device)?.has(event.ctl);
      lastScreen.set(event.device, event);
      tappedOn.set(event.device, new Set());
      if (flash) continue;
    }
    kept.push(event);
  }
  return kept;
}

/** Taps that only move between screens (the rail, the keys, the header, the Floor's dock, the menu): never the action undone. */
const MOVES = ["shell.", "floor.dock.", "menu", "jobs.red.open"];

/** Why each id reads Rework? on `device`, from its events oldest first. */
export function reworkOf(events: readonly UsageEventRow[]): Map<string, UsageRework> {
  const visits = new Map<string, { opens: number; quick: number }>();
  const uses = new Map<string, number>();
  const undone = new Map<string, number>();
  const lastTap = new Map<string, number>();
  let before: { id: string; at: number } | null = null;
  let lastVisit: { id: string; at: number } | null = null;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (event.kind === "tap") {
      lastTap.set(event.screen, at);
      if (UNDO_IDS.has(event.ctl)) {
        if (before && at - before.at <= REWORK_UNDO_MS) undone.set(before.id, (undone.get(before.id) ?? 0) + 1);
        before = null;
      } else {
        uses.set(event.ctl, (uses.get(event.ctl) ?? 0) + 1);
        // Moving between screens undoes nothing: an Undo still on screen after it undoes the action before.
        if (!MOVES.some((prefix) => event.ctl.startsWith(prefix))) before = { id: event.ctl, at };
      }
    } else if (event.kind === "screen" && event.ctl === event.screen) {
      const visit = visits.get(event.ctl) ?? { opens: 0, quick: 0 };
      visit.opens += 1;
      // Closed with a screen over it (Decide with its Answered): its time went to that screen, so it was no quick exit.
      const over = lastVisit !== null && lastVisit.id !== event.ctl && at - lastVisit.at <= JOIN_MS;
      if (event.value < REWORK_QUICK_MS && !over && (lastTap.get(event.ctl) ?? -Infinity) < at - event.value) visit.quick += 1;
      visits.set(event.ctl, visit);
      lastVisit = { id: event.ctl, at };
    }
  }
  const rework = new Map<string, UsageRework>();
  for (const [id, { opens, quick }] of visits) if (quick >= REWORK_MIN_TIMES && quick * 2 >= opens) rework.set(id, { opens, quick });
  for (const [id, count] of undone) {
    const used = uses.get(id) ?? 0;
    if (used >= REWORK_MIN_TIMES && count >= used * REWORK_UNDO_SHARE) rework.set(id, { ...rework.get(id), uses: used, undone: count });
  }
  return rework;
}

/** The page: `events` are every device's in the window, oldest first; `first` the first event kept. */
export function usageReport(input: { events: readonly UsageEventRow[]; first: string | null; asks: readonly UsageAskRow[]; device: UsageDevice; now: Date }): UsageReport {
  const { device, now } = input;
  const events = readable(input.events);
  const rec = recording(input.first, now);
  if (!rec) return { device, since: null, recorded: 0, days: 0, taps: 0, opened: 0, daysUsed: 0, often: [], rarely: [], never: null, features: [] };
  const asked = askedOf(input.asks, now);
  const mine = events.filter((event) => event.device === device);
  const counts = new Map<string, { count: number; last: string }>();
  for (const event of mine) {
    if (event.kind !== "tap" && event.kind !== "screen") continue;
    const entry = counts.get(event.ctl);
    if (entry) {
      entry.count += 1;
      entry.last = event.at;
    } else counts.set(event.ctl, { count: 1, last: event.at });
  }
  const days = Math.min(USAGE_WINDOW_DAYS, Math.max(1, rec.recorded));
  // A zone is a whole number of minutes off UTC, so an ISO time's UTC minute names its local day.
  const dayOf = new Map<string, string>();
  const day = (at: string) => {
    const minute = at.slice(0, 16);
    let found = dayOf.get(minute);
    if (found === undefined) dayOf.set(minute, (found = localDay(at)));
    return found;
  };
  const rework = reworkOf(mine);
  const row = (entry: UsageId, count = 0, last?: string): UsageRow => {
    const perDay = Math.round(count / days);
    const state = asked.get(entry.id);
    const why = rework.get(entry.id);
    return {
      id: entry.id,
      label: entry.label,
      where: entry.where,
      count,
      ...(perDay >= 1 ? { perDay } : {}),
      ...(last ? { last: day(last) } : {}),
      ...(why ? { rework: why } : {}),
      ...(state ? { asked: state } : {}),
    };
  };
  const never = rec.recorded < USAGE_WINDOW_DAYS ? null : neverUsed(events, rec.start, now).map((entry) => row(entry));
  const used = LISTED_IDS.flatMap((entry) => {
    const use = counts.get(entry.id);
    return use ? [row(entry, use.count, use.last)] : [];
  }).sort((a, b) => b.count - a.count || (b.last ?? "").localeCompare(a.last ?? ""));
  return {
    device,
    since: rec.since,
    recorded: rec.recorded,
    days,
    taps: mine.filter((event) => event.kind === "tap").length,
    opened: mine.filter((event) => event.kind === "screen" && event.ctl === event.screen).length,
    daysUsed: new Set(mine.map((event) => day(event.at))).size,
    often: used.filter((one) => one.count > RARELY_MAX).slice(0, OFTEN),
    rarely: used.filter((one) => one.count <= RARELY_MAX),
    never,
    features: features(events, day, { rework, asked, retire: new Set(never?.map((one) => one.id)) }),
  };
}

/**
 * The folds' rows: every FOLD_IDS feature's uses on each device, its days and last day. A use is a tap or a screen
 * opened; a sheet a phone shows in a tab's place counts for that tab too (SHEET_SHOWS), as it does for never used.
 */
function features(
  events: readonly UsageEventRow[],
  day: (at: string) => string,
  page: { rework: Map<string, UsageRework>; asked: Map<string, "asked" | "kept">; retire: Set<string> },
): UsageFeature[] {
  const uses = new Map<string, { phone: number; desktop: number; days: Set<string>; last: string }>();
  for (const event of events) {
    if (event.kind !== "tap" && event.kind !== "screen") continue;
    // Only a screen stands in for its tab: Answered's segment tap is followed by its own answered screen, so crediting
    // the tap as well would count one visit twice.
    for (const id of [event.ctl, ...(event.kind === "screen" ? (SHEET_SHOWS[event.ctl] ?? []) : [])]) {
      let use = uses.get(id);
      if (!use) uses.set(id, (use = { phone: 0, desktop: 0, days: new Set(), last: event.at }));
      use[event.device] += 1;
      use.days.add(day(event.at));
      if (event.at > use.last) use.last = event.at;
    }
  }
  return FOLD_IDS.map((entry) => {
    const use = uses.get(entry.id);
    const days = use?.days.size ?? 0;
    const rework = page.rework.get(entry.id);
    const asked = page.asked.get(entry.id);
    return {
      id: entry.id,
      label: entry.label,
      area: usageArea(entry),
      phone: use?.phone ?? 0,
      desktop: use?.desktop ?? 0,
      days,
      ...(use ? { last: day(use.last) } : {}),
      status: usageStatus(entry, (use?.phone ?? 0) + (use?.desktop ?? 0), days),
      ...(entry.removed ? { removed: entry.removed } : {}),
      ...(page.retire.has(entry.id) ? { retire: true as const } : {}),
      ...(rework && !entry.removed ? { rework } : {}),
      ...(asked ? { asked } : {}),
    };
  });
}

/**
 * A phone shows the Cards and Chat tabs as the Floor's Decide and Rivet sheets (web floor.ts syncSheets), and Answered
 * as Decide's Answered segment. Readings showed More until both went on 3 Nov; the pair stays for older events.
 */
const SHEET_SHOWS: Record<string, readonly string[]> = { decide: ["cards"], "decide.seg.answered": ["answered"], "floor.rivet": ["chat"], readings: ["more"] };

/**
 * Every listed id no device used in the window, once it has had 30 days: from its `added` day, or from when recording
 * began if that is later.
 */
function neverUsed(events: readonly UsageEventRow[], start: number, now: Date): UsageId[] {
  const used = new Set(events.flatMap((event) => (event.kind === "tap" || event.kind === "screen" ? [event.ctl, ...(SHEET_SHOWS[event.ctl] ?? [])] : [])));
  return LISTED_IDS.filter((entry) => !used.has(entry.id) && now.getTime() - Math.max(localAt(entry.added, 0).getTime(), start) >= USAGE_WINDOW_DAYS * DAY_MS);
}

const slug = (id: string) => id.replace(/\./g, "-");

/**
 * A Retire? or Rework? decision card. Each option's detail is what Rivet is asked to do when you pick it; the bridge
 * carries it with your answer (http.ts choiceDetail, bridge templates.mjs choiceDetailSentence).
 */
export function askCard(entry: UsageId, ask: UsageAsk, day: string, numbers: { device: UsageDevice; rework?: UsageRework }): { id: string } & Record<string, unknown> {
  const name = `${entry.label} (usage id ${entry.id}, ${entry.where})`;
  const said = numbers.rework ? `on the ${DEVICE_WORDS[numbers.device]} in the last 30 days, ${reworkWords(numbers.rework)}` : "not used on the phone or the computer in 30 days";
  const retire = {
    label: "Retire",
    detail: `Open an issue to retire ${name}. Its PR removes it from the app. Nothing is removed before that PR merges.`,
  };
  const keep = { label: "Keep", detail: `Keep ${name}. The server keeps it off Retire? for ${USAGE_ASK_HIDES_DAYS} days; nothing to do.` };
  const rework = { label: "Rework", detail: `Open an issue to rework ${name}, with its numbers from What you used: ${said}.` };
  const title =
    ask === "retire"
      ? `Retire ${entry.label}? Not ${entry.kind === "screen" ? "opened" : "tapped"} in 30 days.`
      : `Rework ${entry.label}? ${reworkWords(numbers.rework ?? {}).replace(/^./, (first) => first.toUpperCase())}.`;
  return { id: `usage-${ask}-${day}-${entry.id}`, kind: DECISION, title, options: ask === "retire" ? [retire, keep, rework] : [rework, keep, retire] };
}

export interface UsageAsksDeps {
  store: Pick<Store, "usageEvents" | "usageFirstAt" | "usageAsks" | "addUsageAsk" | "answerUsageAsk">;
  /** routes/router.ts addUpdate: a decision card keeps its kind. */
  addUpdate(card: { id: string } & Record<string, unknown>): { status: number; error?: string };
  now(): Date;
  logger: Pick<Console, "error">;
}

export interface UsageAsks {
  report(device: UsageDevice, now?: Date): UsageReport;
  /** Retire? or Rework? tapped on the page: the card's id, or why there is none. */
  ask(id: string, ask: UsageAsk, device: UsageDevice): { card: string } | { status: number; error: string };
  /** The Monday line's count: ids never used in 30 days, or null before 30 full days of recording. */
  neverCount(now: Date): number | null;
  /** The Monday pass: up to 3 Retire? cards a week, from Mon 30 Nov; safe to call every minute. */
  weekly(): number;
  /** Your answer on any card: an ask's is kept, so Keep holds the id off Retire?. */
  answered(card: string, answer: string, at: string): void;
}

export function createUsageAsks(deps: UsageAsksDeps): UsageAsks {
  let passed: string | null = null;

  const report = (device: UsageDevice, now = deps.now()) =>
    usageReport({
      events: deps.store.usageEvents(new Date(now.getTime() - USAGE_WINDOW_DAYS * DAY_MS).toISOString()),
      first: deps.store.usageFirstAt(),
      asks: deps.store.usageAsks(new Date(now.getTime() - USAGE_ASK_HIDES_DAYS * DAY_MS).toISOString()),
      device,
      now,
    });

  const send = (entry: UsageId, ask: UsageAsk, weekly: boolean, now: Date, numbers: { device: UsageDevice; rework?: UsageRework }) => {
    const card = askCard(entry, ask, localDay(now), numbers);
    const added = deps.addUpdate(card);
    if (added.status !== 200) {
      deps.logger.error(`[usage] ${ask} card for ${entry.id} refused (${added.status}): ${added.error ?? "unknown"}`);
      return null;
    }
    deps.store.addUsageAsk({ card: card.id, ctl: entry.id, ask, weekly, at: now.toISOString() });
    return card.id;
  };

  return {
    report,
    ask(id, ask, device) {
      const entry = LISTED_IDS.find((one) => one.id === id);
      if (!entry) return { status: 400, error: "not a feature What you used lists" };
      const now = deps.now();
      const read = report(device, now);
      // The folds offer Rework? on any row its numbers name, past Used often's first 10 too.
      const row = ask === "retire" ? read.never?.find((one) => one.id === id) : read.features.find((one) => one.id === id && one.rework);
      if (!row) return { status: 409, error: ask === "retire" ? "it was used in the last 30 days" : "its numbers no longer say Rework?" };
      if (row.asked) return { status: 409, error: "a card already asked about it" };
      const card = send(entry, ask, false, now, { device, ...(row.rework ? { rework: row.rework } : {}) });
      return card ? { card } : { status: 503, error: "the card could not be added" };
    },
    neverCount(now) {
      return report("phone", now).never?.length ?? null;
    },
    weekly() {
      const now = deps.now();
      const day = localDay(now);
      if (passed === day || localWeekday(now) !== 1 || day < RETIRE_CARDS_FROM || now < localAt(day, MORNING_HOUR)) return 0;
      const read = report("phone", now);
      const weekFrom = localAt(day, 0).toISOString();
      const made = deps.store.usageAsks(weekFrom).filter((ask) => ask.weekly && ask.at >= weekFrom).length;
      const picks = (read.never ?? []).filter((row) => !row.asked).slice(0, Math.max(0, RETIRE_CARDS_A_WEEK - made));
      let sent = 0;
      let failed = false;
      for (const pick of picks) {
        if (send(LISTED_IDS.find((one) => one.id === pick.id)!, "retire", true, now, { device: "phone" })) sent += 1;
        else failed = true;
      }
      if (!failed) passed = day;
      return sent;
    },
    answered(card, answer, at) {
      if (card.startsWith("usage-")) deps.store.answerUsageAsk(card, answer, at);
    },
  };
}
