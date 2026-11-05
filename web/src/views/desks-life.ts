import type { Ask } from "../../../src/shared/asks.js";
import { STAGE_LABELS, type ComingStage } from "../../../src/shared/board.js";
import type { TimelineEvent, TimelineResponse } from "../../../src/shared/ops.js";
import { fallbackTitle, shownTitle } from "../../../src/shared/short-titles.js";
import type { Worker } from "../../../src/shared/workers.js";
import { IN_HAND, NEEDS_YOU, stageWord } from "../../../src/shared/words.js";
import { h } from "../dom.js";
import { MOOD_WORDS, setMood, type Mood } from "../rivet/rivet.js";

/**
 * The desks come alive: now and then an
 * agent flies to Rivet's desk or another desk and back, and one or two speech bubbles at a time say what an agent is
 * doing, in its ask row's words, never a time. A PR merging while the floor is open makes Rivet cheer.
 * With reduced motion nobody flies and the bubbles stand still.
 */

/** A bubble's words run to this many characters at most, cut at a word. */
const SAY_MAX = 64;
/** A merge or ship this recent is Rivet's news. */
const NEWS_MS = 12 * 3_600_000;
/** A merge first read later than this after it happened is old news: no cheer. */
const CHEER_FRESH_MS = 15 * 60_000;
const FIRST_MS = 900;
const SAY_MS = 4_200;
const GAP_MS = 2_600;
const CHEER_MS = 4_500;
const MAX_BUBBLE_W = 260;

/** Words cut to `max` at a word, without a trailing PR number. */
export function short(text: string, max = SAY_MAX): string {
  const clean = text.replace(/\s*\(#\d+\)\s*$/, "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,:;·–-]+$/, "")}…`;
}

const mergeEvents = (timeline: TimelineResponse | null): TimelineEvent[] =>
  (timeline?.days ?? []).flatMap((day) => day.events).filter((event) => event.kind === "merged" || event.kind === "shipped");

export const mergeKey = (event: TimelineEvent): string => `${event.repo}#${event.number ?? event.title}`;

/** The PRs merged or shipped in the last 12 hours by Ops' timeline, newest first. */
export function recentMerges(timeline: TimelineResponse | null, now = Date.now()): TimelineEvent[] {
  return mergeEvents(timeline)
    .filter((event) => event.at !== null && now - Date.parse(event.at) <= NEWS_MS)
    .sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!));
}

/** The chat a merged PR was: its branch checked out, or the PR on its board entry or Coming item. */
export function mergedBy(event: TimelineEvent, crew: readonly Worker[]): Worker | undefined {
  return crew.find(
    (w) =>
      (w.repo === event.repo || w.repo.endsWith(`/${event.repo}`)) &&
      ((event.branch !== undefined && w.branch === event.branch) ||
        (event.number !== undefined && (w.prs?.includes(event.number) || w.delivering?.pr === event.number))),
  );
}

/** A merge's news: its short title when the server sent one, else its PR title's first clause. */
export const mergedWords = (event: TimelineEvent): string =>
  `${event.kind === "shipped" ? "Shipped" : "Merged"}: ${shownTitle(event.short, event.title.replace(/\s*\(#\d+\)\s*$/, ""))}`;

/** A Coming stage before its item's title. */
const STAGE_SAYS: Record<ComingStage, string> = STAGE_LABELS;

/**
 * The ask's stage as the map reads it: needs-you only with an open card behind it (`holds`), as the Decide count and
 * Cards read it. An ask left at needs-you once its card is answered, or one with no card, reads as no stage here, so the
 * map never says "2 need you" over Open 0.
 */
export const mapStage = (ask: Ask | undefined, holds: boolean): Ask["stage"] | undefined => (ask?.stage === "needs-you" && !holds ? undefined : ask?.stage);

/** The chat's own stage words as the map reads them: free text, so they may say Needs you, which only an open card may. */
export const mapSaid = (w: Worker, holds: boolean): string | undefined => (w.stage === NEEDS_YOU && !holds ? undefined : w.stage);

/** The chat's Coming stage as the map reads it: owner-ok says Needs you, so it too needs an open card behind it. */
export const mapComing = (w: Worker, holds: boolean): ComingStage | undefined => (w.delivering?.stage === "owner-ok" && !holds ? undefined : w.delivering?.stage);

/**
 * What an agent says, at most two lines: its merge (its ask's own PR, when it has an ask), then its ask row's stage and words (the
 * bubbles say what the rows say), else what its own record holds: a wait on you, its Coming stage, its own stage, its %. Never a time, which its status line under it gives, and never its
 * personal name.
 */
export function agentLines(w: Worker, merges: readonly TimelineEvent[] = [], ask?: Ask, holds = w.state === "waiting" || !!w.needsYou): string[] {
  const lines: string[] = [];
  // With an ask row, only a merge of that ask's own PRs: an older PR the chat still lists is not what its row says.
  const merged = merges.find((event) => mergedBy(event, [w]) && (!ask || (event.number !== undefined && ask.prs.includes(event.number))));
  if (merged) lines.push(mergedWords(merged));
  if (ask) {
    const title = shownTitle(ask.short, ask.words);
    const stage = mapStage(ask, holds);
    lines.push(short(stage ? `${stageWord(stage)}: ${title}` : title));
    if (ask.stage === "building" && ask.progress !== undefined) lines.push(short(`${title}: ${Math.round(ask.progress * 100)}% done`));
    return [...new Set(lines)].slice(0, 2);
  }
  const said = w.what ?? w.doing;
  const what = said ? shownTitle(w.short, said) : undefined;
  // Needs you only from an agent holding an open decision card (`holds`, its seat's ?): one waiting with none says not.
  if (holds) lines.push(what && w.state === "waiting" ? short(`${NEEDS_YOU}: ${what}`) : NEEDS_YOU);
  const coming = mapComing(w, holds);
  const stageSaid = mapSaid(w, holds);
  if (w.delivering && coming && STAGE_SAYS[coming]) lines.push(short(`${STAGE_SAYS[coming]}: ${fallbackTitle(w.delivering.title.replace(/\s*\(#\d+\)\s*$/, ""))}`));
  else if (stageSaid) lines.push(short(what ? `${stageSaid}: ${what}` : stageSaid));
  if (what && w.progress !== undefined && w.state !== "waiting") lines.push(short(`${what}: ${Math.round(w.progress * 100)}% done`));
  if (!lines.length && what && w.state === "working") lines.push(short(`${IN_HAND.building}: ${what}`));
  return [...new Set(lines)].slice(0, 2);
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Side = "above" | "below" | "left" | "right";

const hits = (a: Box, b: Box, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * Where a bubble of `size` goes beside its speaker `by`: wholly inside `room`, clear of its speaker and every `keep` box
 * (desk names, the other bubble, the OK pill), over as little of `soft` as it can. Null when nowhere fits.
 */
export function placeBubble(
  size: { w: number; h: number },
  by: Box,
  room: Box,
  keep: readonly Box[],
  soft: readonly Box[],
): (Box & { side: Side; tail: number; score: number }) | null {
  const gap = 10;
  const cx = by.x + by.w / 2;
  const cy = by.y + by.h / 2;
  const across = (x: number) => clamp(x, room.x, room.x + room.w - size.w);
  const down = (y: number) => clamp(y, room.y, room.y + room.h - size.h);
  const tries: [Side, number, number][] = [
    ["above", across(cx - size.w / 2), by.y - size.h - gap],
    ["above", across(by.x - 8), by.y - size.h - gap],
    ["above", across(by.x + by.w + 8 - size.w), by.y - size.h - gap],
    ["below", across(cx - size.w / 2), by.y + by.h + gap],
    ["right", by.x + by.w + gap, down(cy - size.h / 2)],
    ["left", by.x - size.w - gap, down(cy - size.h / 2)],
  ];
  let best: (Box & { side: Side; tail: number; score: number }) | null = null;
  let bestScore = Infinity;
  tries.forEach(([side, x, y], order) => {
    const box = { x, y, w: size.w, h: size.h };
    if (x < room.x || y < room.y || x + size.w > room.x + room.w || y + size.h > room.y + room.h) return;
    if (hits(box, by) || keep.some((one) => hits(box, one, 6))) return;
    const score = soft.reduce((sum, one) => sum + overlap(box, one), 0) + order;
    if (score >= bestScore) return;
    bestScore = score;
    const tail = side === "above" || side === "below" ? clamp(cx - x, 16, size.w - 16) : clamp(cy - y, 14, size.h - 14);
    best = { ...box, side, tail, score };
  });
  return best;
}

const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where `node` sits in the floor's own scrolled content, by layout: a square on a trip is measured at home. */
export function layoutBox(floor: HTMLElement, node: HTMLElement): Box {
  let x = 0;
  let y = 0;
  for (let at: HTMLElement | null = node; at && at !== floor; at = at.offsetParent as HTMLElement | null) {
    x += at.offsetLeft;
    y += at.offsetTop;
    // The boxes' row scrolls sideways under the floor: read where a box is now.
    const parent = at.offsetParent as HTMLElement | null;
    if (parent && parent !== floor) x -= parent.scrollLeft;
  }
  return { x, y, w: node.offsetWidth, h: node.offsetHeight };
}

interface Speaker {
  key: string;
  bot: HTMLElement;
  lines: string[];
  worker?: Worker;
}

export interface DeskLife {
  /** The bubbles' layer: the floor appends it after its desks. */
  layer: HTMLElement;
  /** After the floor is rebuilt: the squares are new, so trips and bubbles start over. */
  reset(): void;
  /** After a reading that left the floor as it was: a new merge cheers. */
  update(): void;
  stop(): void;
}

/** The floor's life: who speaks next, the trips, the bubbles and the cheer. */
/** `askOf` is an agent's ask row, which its bubble reads. */
export function deskLife(
  floor: HTMLElement,
  crew: () => Worker[],
  askOf: (w: Worker) => Ask | undefined,
  timeline: () => TimelineResponse | null,
): DeskLife {
  const layer = h("div", { class: "desks-talk", attrs: { "aria-hidden": "true" } });
  const timers = new Set<number>();
  const later = (ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };
  let running = false;
  let turn = 0;
  const said = new Map<string, number>();
  let bubbles: { el: HTMLElement; who: string; box: Box }[] = [];
  let away: HTMLElement | null = null;
  /** Every merge the timeline held at the first reading, and every one since. */
  let seen: Set<string> | null = null;
  /** Puts Rivet back as he was before a cheer still running. */
  let unCheer: (() => void) | null = null;

  const showing = () => {
    if (document.visibilityState === "hidden" || !floor.isConnected || !floor.clientWidth) return false;
    const rect = floor.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  };

  const boxOf = (node: Element, base: DOMRect): Box => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left - base.left + floor.scrollLeft, y: rect.top - base.top + floor.scrollTop, w: rect.width, h: rect.height };
  };

  function speakers(): Speaker[] {
    const merges = recentMerges(timeline());
    const list: Speaker[] = [];
    const rivetBot = floor.querySelector<HTMLElement>(".desk.is-rivet .rivet");
    if (rivetBot && merges.length) list.push({ key: "rivet", bot: rivetBot, lines: merges.slice(0, 2).map(mergedWords) });
    const byId = new Map(crew().map((w) => [w.id, w]));
    for (const row of floor.querySelectorAll<HTMLElement>(".desk-agent[data-agent]")) {
      const worker = byId.get(row.dataset.agent!);
      const bot = row.querySelector<HTMLElement>(".rivet");
      // Its seat wears the ? (is-asking) exactly while it holds an open decision card, so its words agree with it.
      // A box scrolled off the side says nothing until it is back.
      const box = bot ? bot.getBoundingClientRect() : null;
      const shown = floor.getBoundingClientRect();
      if (box && (box.right > shown.right || box.left < shown.left)) continue;
      if (worker && bot) list.push({ key: worker.id, bot, lines: agentLines(worker, merges, askOf(worker), row.classList.contains("is-asking")), worker });
    }
    return list.filter((one) => one.lines.length);
  }

  function drop(bubble: HTMLElement): void {
    bubbles = bubbles.filter((one) => one.el !== bubble);
    bubble.classList.remove("is-in");
    bubble.classList.add("is-out");
    later(300, () => bubble.remove());
  }

  /** Measures a bubble beside `by` (the speaker where it is, or will be) and where it would stand; null when it fits nowhere. */
  function fit(who: Speaker, words: string, by: Box): { bubble: HTMLElement; spot: NonNullable<ReturnType<typeof placeBubble>> } | null {
    const news = /^(Merged|Shipped): /.test(words);
    const bubble = h("div", { class: `desks-say${who.key === "rivet" ? " is-rivet" : ""}${news ? " is-news" : ""}` }, words);
    layer.append(bubble);
    const base = floor.getBoundingClientRect();
    const top = floor.scrollTop + (floor.scrollTop > 0 ? parseFloat(getComputedStyle(floor).paddingTop) || 0 : 8);
    // The floor grows with its boxes on a page that scrolls: a bubble also stays inside what that page shows, above the Decide band.
    const view = floor.closest<HTMLElement>("main.view")?.getBoundingClientRect();
    const shown = view?.height ? view.bottom - floor.getBoundingClientRect().top + floor.scrollTop : Infinity;
    const room = { x: 8, y: top, w: floor.clientWidth - 16, h: Math.min(floor.scrollTop + floor.clientHeight, shown) - 8 - top };
    // Every agent's row stays clear, but standing still a bubble may cover its own row's status line, which it says.
    const own = who.bot.closest(".desk-agent");
    const rows = [...floor.querySelectorAll<HTMLElement>(".desk-agent-tip")].filter((tip) => !still() || !own?.contains(tip));
    const keep = [
      ...[...floor.querySelectorAll(".desk-name, .desk-head, .desk-agent-what, .desks-more, .desk.is-rivet .rivet")].map((node) => boxOf(node, base)),
      ...rows.map((node) => boxOf(node, base)),
      ...bubbles.map((one) => one.box),
    ];
    const soft = [...floor.querySelectorAll(".desk-agent-tip, .rivet, .desk-slab")].map((node) => boxOf(node, base));
    // Narrower bubbles can stand beside a desk where a wide one would not fit; the least in the way wins.
    let spot: ReturnType<typeof placeBubble> = null;
    let width = 0;
    for (const max of [MAX_BUBBLE_W, 220, 180, 140, 110]) {
      bubble.style.maxWidth = `${Math.min(max, floor.clientWidth - 24)}px`;
      const size = { w: bubble.offsetWidth, h: bubble.offsetHeight };
      const one = size.w && size.h ? placeBubble(size, by, room, keep, soft) : null;
      if (one && (!spot || one.score < spot.score - 200)) {
        spot = one;
        width = max;
      }
    }
    if (!spot) {
      bubble.remove();
      return null;
    }
    bubble.style.maxWidth = `${Math.min(width, floor.clientWidth - 24)}px`;
    return { bubble, spot };
  }

  /** A bubble beside `by`; false when it fits nowhere, and nothing is shown. */
  function say(who: Speaker, words: string, by: Box = layoutBox(floor, who.bot)): boolean {
    const fitted = fit(who, words, by);
    if (!fitted) return false;
    const { bubble, spot } = fitted;
    bubble.style.left = `${spot.x}px`;
    bubble.style.top = `${spot.y}px`;
    bubble.style.setProperty("--tail", `${spot.tail}px`);
    bubble.dataset.side = spot.side;
    bubbles.push({ el: bubble, who: who.key, box: spot });
    if (still()) bubble.classList.add("is-in");
    else {
      requestAnimationFrame(() => bubble.classList.add("is-in"));
      later(SAY_MS, () => drop(bubble));
    }
    return true;
  }

  /** Where an agent going up to Rivet may hover, best first: beside his desk, nearer side first, never another box. */
  function visitSpots(who: Speaker): Box[] {
    const home = layoutBox(floor, who.bot);
    const slab = floor.querySelector<HTMLElement>(".desk.is-rivet .desk-slab");
    if (!slab) return [];
    const desk = layoutBox(floor, slab);
    const size = home.w;
    const at = (x: number, y: number): Box => ({ x: clamp(x, 8, floor.clientWidth - size - 8), y, w: size, h: size });
    const left = desk.x - size - 10;
    const right = desk.x + desk.w + 10;
    const sides = home.x + size / 2 < desk.x + desk.w / 2 ? [left, right] : [right, left];
    // Level with his desk, or up by his face, where a bubble has the floor's top over it.
    const face = floor.querySelector<HTMLElement>(".desk.is-rivet .rivet");
    const ys = [desk.y - size * 0.4, ...(face ? [layoutBox(floor, face).y] : [])];
    return ys.flatMap((y) => sides.map((x) => at(x, y)));
  }

  /** Flies an agent to `spot`, says its line there, and brings it home. */
  function trip(who: Speaker, spot: Box, words: string, glance: "l" | "r" | null): void {
    const home = layoutBox(floor, who.bot);
    const dx = spot.x - home.x;
    const dy = spot.y - home.y;
    const ms = Math.round(Math.min(2_200, 900 + Math.hypot(dx, dy) * 2));
    const bot = who.bot;
    const rivetBot = floor.querySelector<HTMLElement>(".desk.is-rivet .rivet");
    away = bot;
    // The boxes' row clips what leaves it, so a copy flies on the floor's own layer while the agent's seat holds its ghost.
    const flyer = bot.cloneNode(true) as HTMLElement;
    flyer.classList.add("desks-flyer", "is-away");
    flyer.style.left = `${home.x}px`;
    flyer.style.top = `${home.y}px`;
    flyer.style.width = `${home.w}px`;
    flyer.style.setProperty("--trip-ms", `${ms}ms`);
    layer.append(flyer);
    bot.classList.add("is-away");
    bot.style.visibility = "hidden";
    bot.parentElement?.style.setProperty("--ghost", `${home.w}px`);
    bot.parentElement?.classList.add("has-away");
    requestAnimationFrame(() => {
      flyer.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    later(ms, () => {
      if (!bot.isConnected) return;
      if (glance) rivetBot?.classList.add(`is-glance-${glance}`);
      say(who, words, spot);
      later(SAY_MS, () => {
        rivetBot?.classList.remove("is-glance-l", "is-glance-r");
        flyer.style.transform = "";
        later(ms, () => {
          flyer.remove();
          bot.style.visibility = "";
          bot.classList.remove("is-away");
          bot.parentElement?.classList.remove("has-away");
          if (away === bot) away = null;
        });
      });
    });
  }

  function tick(): void {
    if (!running) return;
    if (!showing() || bubbles.length >= 2) return later(1_500, tick);
    const list = speakers().filter((one) => one.bot !== away && !bubbles.some((bubble) => bubble.who === one.key));
    if (!list.length) return later(1_500, tick);
    const who = list[turn++ % list.length]!;
    const n = said.get(who.key) ?? 0;
    said.set(who.key, n + 1);
    const words = who.lines[n % who.lines.length]!;
    const fly = (go: boolean): boolean => {
      if (!go || !who.worker || away) return false;
      // Only where its line will have room when it lands.
      const spot = visitSpots(who).find((one) => {
        const fitted = fit(who, words, one);
        fitted?.bubble.remove();
        return fitted;
      });
      if (!spot) return false;
      const rivetSlab = floor.querySelector<HTMLElement>(".desk.is-rivet .desk-slab");
      trip(who, spot, words, rivetSlab ? (spot.x < layoutBox(floor, rivetSlab).x ? "l" : "r") : null);
      later(GAP_MS + 1_500, tick);
      return true;
    };
    // A trip only ever goes up to Rivet: a report always, any other line three times in four (the quarter that went to
    // another project's box now goes to him too). The rest say it where they sit.
    const report = /^(Merged|Shipped|Waiting)/.test(words);
    if (fly(report || Math.random() < 0.75)) return;
    if (say(who, words)) return later(GAP_MS, tick);
    if (fly(true)) return;
    // No room here and no trip to take: the line waits for its next turn, and the next speaker tries soon.
    said.set(who.key, n);
    later(700, tick);
  }

  /** Reduced motion: the first two speakers' lines, standing still at their desks until the floor changes. */
  function standStill(): void {
    if (!running) return;
    if (!showing()) return later(1_500, standStill);
    for (const who of speakers()) {
      if (bubbles.length >= 2) break;
      if (!bubbles.some((bubble) => bubble.who === who.key)) say(who, who.lines[0]!);
    }
  }

  function halt(): void {
    running = false;
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    bubbles = [];
    layer.replaceChildren();
    if (away) {
      away.style.transform = "";
      away.style.visibility = "";
      away.classList.remove("is-away");
      away.parentElement?.classList.remove("has-away");
      away = null;
    }
    floor.querySelectorAll(".is-glance-l, .is-glance-r").forEach((node) => node.classList.remove("is-glance-l", "is-glance-r"));
    unCheer?.();
  }

  function start(): void {
    if (document.visibilityState === "hidden") return;
    running = true;
    later(FIRST_MS, still() ? standStill : tick);
  }

  /** Rivet cheers a merge: happy and "Shipped" for a few seconds, a hop and a small burst inside his box, and he says it. */
  function cheer(event: TimelineEvent): void {
    const desk = floor.querySelector<HTMLElement>(".desk.is-rivet");
    const bot = desk?.querySelector<HTMLElement>(".rivet");
    const word = desk?.querySelector<HTMLElement>(".desk-mood");
    if (!desk || !bot || !word) return;
    unCheer?.();
    const mood = desk.dataset.mood as Mood;
    const was = word.textContent;
    setMood(bot, "happy");
    word.textContent = MOOD_WORDS.happy;
    desk.classList.add("is-cheer");
    const by = mergedBy(event, crew());
    const agent = by ? [...floor.querySelectorAll<HTMLElement>(".desk-agent[data-agent]")].find((row) => row.dataset.agent === by.id)?.querySelector<HTMLElement>(".rivet") : null;
    agent?.classList.add("is-cheer");
    if (!still()) {
      const burst = h("span", { class: "desk-burst" }, ...Array.from({ length: 10 }, () => h("i")));
      [...burst.children].forEach((spark, i) => (spark as HTMLElement).style.setProperty("--a", `${i * 36}deg`));
      bot.append(burst);
      later(1_200, () => burst.remove());
    }
    const mine = bubbles.find((one) => one.who === "rivet") ?? (bubbles.length >= 2 ? bubbles[0] : undefined);
    if (mine) drop(mine.el);
    say({ key: "rivet", bot, lines: [] }, mergedWords(event));
    unCheer = () => {
      unCheer = null;
      if (!bot.isConnected) return;
      setMood(bot, mood);
      word.textContent = was;
      desk.classList.remove("is-cheer");
      agent?.classList.remove("is-cheer");
    };
    later(CHEER_MS, () => unCheer?.());
  }

  function update(): void {
    const read = timeline();
    if (!read) return;
    const all = mergeEvents(read);
    if (!seen) {
      seen = new Set(all.map(mergeKey));
      return;
    }
    const now = Date.now();
    const fresh = recentMerges(read, now).filter((event) => !seen!.has(mergeKey(event)) && now - Date.parse(event.at!) <= CHEER_FRESH_MS);
    for (const event of all) seen.add(mergeKey(event));
    if (fresh.length && running && showing()) cheer(fresh[0]!);
  }

  const onVisible = () => {
    halt();
    start();
  };
  document.addEventListener("visibilitychange", onVisible);

  return {
    layer,
    reset() {
      halt();
      start();
      update();
    },
    update,
    stop() {
      halt();
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
