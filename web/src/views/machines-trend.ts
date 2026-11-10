import "./machines-trend.css";

import { MACHINE_HISTORY_MS, type MachineHistoryResponse, type MachineMetric } from "../../../src/shared/machines.js";
import type { OpsResponse } from "../../../src/shared/ops.js";
import { clock, dayClock, dayDate, hourLabel, weekday } from "../../../src/shared/when.js";
import * as api from "../api.js";
import { h, type Child } from "../dom.js";
import { onSessionReset } from "../session.js";

/**
 * The Machines trend: one line per machine from the readings the server keeps, a pill per metric, range pills, a
 * sideways drag through time and a pinch to zoom. A vertical swipe stays the page's.
 */

/** A move this far from the touch is no longer a tap. */
const DRAG_PX = 10;

/** A move of `dx`, `dy` px from the touch: still a tap (null), a mainly sideways drag, or a vertical swipe the page scrolls. */
function gesture(dx: number, dy: number): "drag" | "scroll" | null {
  if (Math.hypot(dx, dy) < DRAG_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? "drag" : "scroll";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const RANGES = [
  { label: "1h", ms: HOUR },
  { label: "6h", ms: 6 * HOUR },
  { label: "24h", ms: DAY },
  { label: "7d", ms: 7 * DAY },
] as const;
const MIN_SPAN = 30 * MINUTE;
const MAX_SPAN = 7 * DAY;

export const METRICS: readonly { id: MachineMetric; pill: string; noun: string; title: string }[] = [
  // Load keeps the queue, which runs past 100.
  { id: "cpuUsedPct", pill: "CPU", noun: "CPU", title: "CPU in use: 100% = every core busy" },
  { id: "loadPct", pill: "Load", noun: "load", title: "Load: 100% = a job per core; above it, jobs wait" },
  { id: "memUsedPct", pill: "Memory", noun: "memory", title: "Memory used" },
  { id: "diskFreePct", pill: "Disk free", noun: "disk", title: "Disk free" },
  { id: "batteryPct", pill: "Battery", noun: "battery", title: "Battery" },
];

/** A machine keeps its colour on every metric, by its place in the list. No green or red: those mean up and down. */
const COLOURS = ["#3987e5", "#199e70", "#d95926", "#c98500", "#9085e9", "#d55181"];

/** Readings further apart than three missed checks are a gap in the line, never a slope across it. */
const GAP_MS = 16 * MINUTE;
const HEIGHT = 220;
const PAD = { left: 46, right: 12, top: 12, bottom: 30 };
/** A y label's character past "100%": the plot's left edge moves over so "1000%" is never cut. */
const TICK_CHAR = 9;
/**
 * The plot's left edge, as the last draw set it from the longest y label the metric's kept readings can need: from all of
 * them, not the window's, so a drag or pinch that moves a peak out of view never changes the scale under the finger.
 */
let padLeft = PAD.left;

interface Point {
  t: number;
  v: Partial<Record<MachineMetric, number>>;
}

interface Machine {
  id: string;
  name: string;
  points: Point[];
}

const trend = {
  metric: "cpuUsedPct" as MachineMetric,
  span: DAY,
  /** The right edge, server ms; null follows now. */
  end: null as number | null,
  /** A tapped time, whose values the legend shows. */
  pick: null as number | null,
  machines: new Map<string, Machine>(),
  /** Server clock minus this device's. */
  skew: 0,
  loaded: false,
  loading: false,
  failed: null as string | null,
  triedAt: 0,
  /** The Mac report the readings were last topped up for. */
  forAt: null as string | null,
};

const serverNow = () => Date.now() + trend.skew;

/** The newest reading's time, epoch seconds: the server sends only what came after it. */
function lastSeconds(): number {
  let last = 0;
  for (const machine of trend.machines.values()) last = Math.max(last, machine.points.at(-1)?.t ?? 0);
  return Math.floor(last / 1000);
}

/** Adds the server's answer to what the page holds, and lets readings past the kept week go. */
export function mergeHistory(answer: MachineHistoryResponse, at = Date.now()): void {
  // Checked before anything is kept: an answer of another shape is a failed load, never a clock of NaN that breaks Ops.
  const now = Date.parse(answer?.now);
  if (!Number.isFinite(now) || !Array.isArray(answer.machines) || !answer.machines.every((m) => Array.isArray(m?.t) && typeof m.values === "object" && m.values !== null))
    throw new Error("the answer was not readings");
  trend.skew = now - at;
  for (const series of answer.machines) {
    const machine = trend.machines.get(series.id) ?? { id: series.id, name: series.name, points: [] };
    machine.name = series.name;
    const last = machine.points.at(-1)?.t ?? 0;
    series.t.forEach((seconds, i) => {
      const t = seconds * 1000;
      if (t <= last) return;
      const v: Point["v"] = {};
      for (const [metric, column] of Object.entries(series.values) as [MachineMetric, (number | null)[]][]) {
        const value = column[i];
        if (typeof value === "number") v[metric] = value;
      }
      machine.points.push({ t, v });
    });
    trend.machines.set(series.id, machine);
  }
  const from = now - MACHINE_HISTORY_MS;
  for (const machine of trend.machines.values()) {
    const keep = machine.points.findIndex((point) => point.t >= from);
    machine.points.splice(0, keep < 0 ? machine.points.length : keep);
  }
}

/** Tops up the readings when the Mac has reported since the last load; a failed load waits a minute before it tries again. */
function load(at: string | null): void {
  if (trend.loading || (trend.loaded && trend.forAt === at)) return;
  if (trend.failed && Date.now() - trend.triedAt < MINUTE) return;
  trend.loading = true;
  trend.triedAt = Date.now();
  const since = lastSeconds();
  const asked = Date.now();
  void api
    .call<MachineHistoryResponse>("GET", `/api/machines/history${since ? `?since=${since}` : ""}`)
    .then((answer) => {
      mergeHistory(answer, asked);
      trend.loaded = true;
      trend.forAt = at;
      trend.failed = null;
    })
    .catch((error: unknown) => {
      trend.failed = error instanceof Error ? error.message : "Couldn't load the readings.";
    })
    .finally(() => {
      trend.loading = false;
      draw();
    });
}

/** Clears what the page holds (tests). */
export function resetTrend(): void {
  Object.assign(trend, { metric: "cpuUsedPct", span: DAY, end: null, pick: null, skew: 0, loaded: false, loading: false, failed: null, triedAt: 0, forAt: null });
  trend.machines = new Map();
  padLeft = PAD.left;
  root = null;
  drawnKey = "";
}

// Geometry (pure)

/** A machine's readings of `metric` within [start, end], with one on each side so a line reaches the edges. */
export function visible(points: readonly Point[], metric: MachineMetric, start: number, end: number): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  for (const point of points) {
    const v = point.v[metric];
    if (v === undefined || point.t < start - GAP_MS || point.t > end + GAP_MS) continue;
    out.push({ t: point.t, v });
  }
  return out;
}

/** Runs of readings with no gap over GAP_MS: each is one stretch of line, a run of one a dot. */
export function runs(points: readonly { t: number; v: number }[]): { t: number; v: number }[][] {
  const out: { t: number; v: number }[][] = [];
  for (const point of points) {
    const run = out.at(-1);
    if (run && point.t - run.at(-1)!.t <= GAP_MS) run.push(point);
    else out.push([point]);
  }
  return out;
}

/** The y axis's top: 100%, or past it in steps of 50 when a load runs past the cores. */
export function yTop(max: number): number {
  return max <= 100 ? 100 : Math.ceil(max / 50) * 50;
}

function yTicks(top: number): number[] {
  const step = top <= 100 ? 25 : [50, 100, 200, 250, 500, 1000, 2500, 5000].find((s) => top / s <= 4) ?? top / 4;
  const out: number[] = [];
  for (let v = 0; v <= top + 0.001; v += step) out.push(v);
  return out;
}

const X_STEPS = [10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY];

/** Time ticks on this device's clock, about one per 72 px: "2pm", "2:30pm", the day's name at midnight and on day steps. */
export function xTicks(start: number, end: number, width: number): { t: number; label: string }[] {
  const step = X_STEPS.find((s) => (end - start) / s <= Math.max(2, width / 72)) ?? 2 * DAY;
  const offset = -new Date(start).getTimezoneOffset() * MINUTE;
  const out: { t: number; label: string }[] = [];
  for (let wall = Math.ceil((start + offset) / step) * step; wall - offset <= end; wall += step) {
    const t = wall - offset;
    const midnight = clock(t) === "12:00am";
    out.push({ t, label: step >= DAY || midnight ? weekday(t) : wall % HOUR ? clock(t) : hourLabel(t) });
  }
  return out;
}

/** "Wed 9:10pm – Thu 3:10am", the day dropped from the end when it is the same; past a day, dates: "Thu 1 Oct – Thu 8 Oct". */
export function windowLabel(start: number, end: number): string {
  if (end - start > DAY) return `${dayDate(start)} – ${dayDate(end)}`;
  return `${dayClock(start)} – ${weekday(start) === weekday(end) ? clock(end) : dayClock(end)}`;
}

/** Keeps a window within the kept week and never past now: at now, it follows now again. */
export function clampWindow(end: number, span: number, now: number): { end: number | null; span: number } {
  const s = Math.min(MAX_SPAN, Math.max(MIN_SPAN, span));
  const e = Math.max(now - MAX_SPAN + s, Math.min(now, end));
  return { end: e >= now - 1000 ? null : e, span: s };
}

// Drawing

const SVG = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  el.append(...children);
  return el;
}

let root: HTMLElement | null = null;
let plot: HTMLElement;
let metricPills: HTMLButtonElement[] = [];
let rangePills: HTMLButtonElement[] = [];
let nowBtn: HTMLButtonElement;
let caption: HTMLElement;
let after: HTMLElement;
let headline: HTMLElement;
let frame = 0;
/** The window listeners of the current chart element, dropped when a new one is built. */
let listening: AbortController | null = null;
onSessionReset(() => {
  Object.assign(trend, { skew: 0, loaded: false, loading: false, failed: null, triedAt: 0, forAt: null });
  trend.machines = new Map();
});

function colourOf(id: string): string | null {
  return COLOURS[machines().findIndex((machine) => machine.id === id)] ?? null;
}

function machines(): { id: string; name: string }[] {
  return [...trend.machines.values()].map(({ id, name }) => ({ id, name }));
}

function plotWidth(): number {
  return Math.max(200, plot.clientWidth || 360);
}

function windowNow(): { start: number; end: number; now: number } {
  const now = serverNow();
  const end = trend.end ?? now;
  return { start: end - trend.span, end, now };
}

const pct = (v: number) => `${Math.round(v)}%`;

/** The reading nearest `t` within a gap's reach, or null. */
function nearest(points: readonly { t: number; v: number }[], t: number): { t: number; v: number } | null {
  let best: { t: number; v: number } | null = null;
  for (const point of points) if (!best || Math.abs(point.t - t) < Math.abs(best.t - t)) best = point;
  return best && Math.abs(best.t - t) <= GAP_MS ? best : null;
}

/**
 * Everything the chart shows, the time to the minute: Ops redraws its page on every poll, and one that changes none of
 * it keeps the chart as drawn rather than building its SVG again mid-scroll.
 */
function chartKey(): string {
  let count = 0;
  let newest = 0;
  for (const machine of trend.machines.values()) {
    count += machine.points.length;
    newest = Math.max(newest, machine.points.at(-1)?.t ?? 0);
  }
  const { end } = windowNow();
  return JSON.stringify([trend.metric, trend.span, trend.end, trend.pick, Math.floor(end / MINUTE), plotWidth(), count, newest, trend.loaded, trend.loading, trend.failed]);
}

let drawnKey = "";

function draw(): void {
  if (!root) return;
  drawnKey = chartKey();
  const { start, end } = windowNow();
  const width = plotWidth();
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const metric = METRICS.find((m) => m.id === trend.metric)!;
  headline.textContent = metric.title;
  metricPills.forEach((btn, i) => {
    const on = METRICS[i]!.id === trend.metric;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
  });
  rangePills.forEach((btn, i) => {
    const on = trend.end === null && RANGES[i]!.ms === trend.span;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
  });
  nowBtn.hidden = trend.end === null;
  caption.textContent = windowLabel(start, end);

  const lines = machines()
    .map((m) => ({ ...m, colour: colourOf(m.id), points: visible(trend.machines.get(m.id)?.points ?? [], trend.metric, start, end) }))
    .map((m) => ({ ...m, shown: m.points.some((p) => p.t >= start && p.t <= end) }));
  const drawn = lines.filter((m) => m.shown && m.colour);
  const missing = lines.filter((m) => !m.shown);
  // Past the checked colours a machine is named, never drawn in a colour that could be mistaken for another's.
  const uncoloured = lines.filter((m) => m.shown && !m.colour);
  const top = yTop(Math.max(0, ...drawn.flatMap((m) => m.points.map((p) => p.v))));
  let most = 0;
  for (const machine of trend.machines.values()) for (const point of machine.points) most = Math.max(most, point.v[trend.metric] ?? 0);
  padLeft = PAD.left + TICK_CHAR * Math.max(0, pct(yTop(most)).length - 4);
  const innerW = width - padLeft - PAD.right;
  const x = (t: number) => padLeft + ((t - start) / (end - start)) * innerW;
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;

  const grid = yTicks(top).flatMap((v) => [
    svg("line", { x1: padLeft, x2: width - PAD.right, y1: y(v), y2: y(v), class: v === 0 ? "trend-base" : "trend-grid" }),
    svg("text", { x: padLeft - 6, y: y(v), class: "trend-tick", "text-anchor": "end", "dominant-baseline": "middle" }, pct(v)),
  ]);
  const ticks = xTicks(start, end, innerW)
    .filter(({ t }) => x(t) >= padLeft + 16 && x(t) <= width - PAD.right - 16)
    .map(({ t, label }) => svg("text", { x: x(t), y: HEIGHT - 8, class: "trend-tick", "text-anchor": "middle" }, label));
  const marks = drawn.flatMap((m) =>
    // Gaps are found in the readings themselves: thinning first would open false gaps across a week.
    runs(m.points).map((run) => decimate(run, start, end, innerW)).map((run) =>
      run.length === 1
        ? svg("circle", { cx: x(run[0]!.t), cy: y(run[0]!.v), r: 3, fill: m.colour!, class: "trend-dot" })
        : svg("path", { d: run.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(""), stroke: m.colour!, class: "trend-line" }),
    ),
  );
  const pick = trend.pick !== null && trend.pick >= start && trend.pick <= end ? trend.pick : null;
  const picked = pick === null ? [] : drawn.map((m) => ({ m, at: nearest(m.points, pick) })).filter((p) => p.at);
  const cross =
    pick === null
      ? []
      : [
          svg("line", { x1: x(pick), x2: x(pick), y1: PAD.top, y2: PAD.top + innerH, class: "trend-cross" }),
          ...picked.map(({ m, at }) => svg("circle", { cx: x(at!.t), cy: y(at!.v), r: 5, fill: m.colour!, class: "trend-pick" })),
        ];
  const message = !drawn.length ? emptyText(metric.noun) : null;
  plot.replaceChildren(
    svg(
      "svg",
      { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: "img", "aria-label": `${metric.title}, ${windowLabel(start, end)}` },
      svg("defs", {}, svg("clipPath", { id: "trend-clip" }, svg("rect", { x: padLeft, y: 0, width: innerW, height: HEIGHT - PAD.bottom + 4 }))),
      ...grid,
      ...ticks,
      svg("g", { "clip-path": "url(#trend-clip)" }, ...marks, ...cross),
    ),
    ...(message ? [h("p", { class: "trend-empty" }, message)] : []),
  );

  const at = pick !== null ? `At ${dayClock(pick)}` : trend.end === null ? "Latest" : `Latest in view`;
  const parts: Child[] = [
    drawn.length
      ? h(
          "div",
          { class: "trend-legend" },
          h("p", { class: "trend-at" }, at),
          h(
            "ul",
            {},
            ...drawn.map((m) => {
              const point = pick !== null ? nearest(m.points, pick) : [...m.points].reverse().find((p) => p.t <= end) ?? null;
              const key = h("span", { class: "trend-key" });
              key.style.background = m.colour!;
              return h("li", { attrs: { "data-machine": m.id } }, key, h("span", { class: "trend-name" }, m.name), h("b", { class: "trend-value" }, point ? pct(point.v) : "—"));
            }),
          ),
        )
      : null,
    missing.length && drawn.length ? h("p", { class: "trend-note" }, `No ${metric.noun} readings${trend.end === null && trend.span === MAX_SPAN ? "" : " in this range"}: ${missing.map((m) => m.name).join(", ")}`) : null,
    uncoloured.length ? h("p", { class: "trend-note" }, `Not drawn, no colour left: ${uncoloured.map((m) => m.name).join(", ")}`) : null,
    // Lines kept from an earlier load still say a newer read failed: never the old figures as the latest, unsaid.
    trend.failed && drawn.length ? h("p", { class: "trend-note trend-failed" }, "Couldn't refresh the readings. These are from the last read.") : null,
  ];
  after.replaceChildren(...parts.filter((part): part is Node | string => !!part));
}

function emptyText(noun: string): string {
  if (!trend.loaded) return trend.failed ? "Couldn't load the readings." : "Loading the readings…";
  if (![...trend.machines.values()].some((m) => m.points.length)) return "No readings yet: the Mac sends them every 5 minutes.";
  return `No ${noun} readings in this range.`;
}

/** At most two readings per pixel column, the lowest and highest, so a week's line stays light and keeps its peaks. */
function decimate(points: { t: number; v: number }[], start: number, end: number, width: number): { t: number; v: number }[] {
  if (points.length <= width * 2) return points;
  const out: { t: number; v: number }[] = [];
  let col = Number.NaN;
  let lo: { t: number; v: number } | null = null;
  let hi: { t: number; v: number } | null = null;
  const flush = () => {
    if (!lo || !hi) return;
    if (lo === hi) out.push(lo);
    else out.push(...(lo.t < hi.t ? [lo, hi] : [hi, lo]));
  };
  for (const point of points) {
    const c = Math.floor(((point.t - start) / (end - start)) * width);
    if (c !== col) {
      flush();
      col = c;
      lo = hi = point;
    } else {
      if (point.v < lo!.v) lo = point;
      if (point.v > hi!.v) hi = point;
    }
  }
  flush();
  return out;
}

function redraw(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    draw();
  });
}

function setWindow(end: number, span: number): void {
  const next = clampWindow(end, span, serverNow());
  trend.end = next.end;
  trend.span = next.span;
  redraw();
}

/** The time under `clientX`. */
function timeAt(clientX: number): number {
  const { start, end } = windowNow();
  const box = plot.getBoundingClientRect();
  const innerW = plotWidth() - padLeft - PAD.right;
  return start + ((clientX - box.left - padLeft) / innerW) * (end - start);
}

/** A tap shows the readings at that time in the legend; a tap on the shown time clears it. */
function tap(clientX: number): void {
  const t = timeAt(clientX);
  const { start, end } = windowNow();
  const msPerPx = (end - start) / (plotWidth() - padLeft - PAD.right);
  if (trend.pick !== null && Math.abs(trend.pick - t) / msPerPx < 22) trend.pick = null;
  else {
    const near = [...trend.machines.values()]
      .flatMap((m) => visible(m.points, trend.metric, start, end))
      .reduce<number | null>((best, p) => (best === null || Math.abs(p.t - t) < Math.abs(best - t) ? p.t : best), null);
    trend.pick = near !== null && Math.abs(near - t) <= GAP_MS ? near : null;
  }
  draw();
}

/** One finger drags through time; two pinch the span about the point between them. A mainly vertical swipe is the page's. */
function listen(el: HTMLElement): void {
  const fingers = new Map<number, { x: number; y: number }>();
  let pan: { x: number; y: number; end: number; mode: "drag" | "scroll" | null } | null = null;
  let pinch: { d: number; span: number; anchor: number; frac: number } | null = null;
  let pinched = false;
  const spread = () => {
    const [a, b] = [...fingers.values()];
    return { d: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)), x: (a!.x + b!.x) / 2 };
  };
  const frac = (clientX: number) => (clientX - el.getBoundingClientRect().left - padLeft) / (plotWidth() - padLeft - PAD.right);
  const begin = () => {
    const { end } = windowNow();
    pinch = null;
    pan = null;
    if (fingers.size >= 2) {
      const { d, x } = spread();
      pinch = { d, span: trend.span, anchor: timeAt(x), frac: frac(x) };
      pinched = true;
    } else if (fingers.size === 1) {
      const [f] = [...fingers.values()];
      // The finger left after a pinch drags on from where it is, never a tap.
      pan = { x: f!.x, y: f!.y, end, mode: pinched ? "drag" : null };
    }
  };
  el.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!fingers.size) pinched = false;
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (fingers.size === 2) {
      for (const id of fingers.keys())
        try {
          el.setPointerCapture(id);
        } catch {
          // A pointer the browser no longer tracks.
        }
    }
    begin();
  });
  el.addEventListener("pointermove", (event) => {
    if (!fingers.has(event.pointerId)) return;
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && fingers.size >= 2) {
      const { d, x } = spread();
      const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, (pinch.span * pinch.d) / d));
      const start = pinch.anchor - frac(x) * span;
      setWindow(start + span, span);
      return;
    }
    if (!pan || pan.mode === "scroll") return;
    if (!pan.mode) {
      pan.mode = gesture(event.clientX - pan.x, event.clientY - pan.y);
      if (pan.mode !== "drag") return;
      pan.x = event.clientX;
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        // Still drags while it stays over the chart.
      }
    }
    const msPerPx = trend.span / (plotWidth() - padLeft - PAD.right);
    setWindow(pan.end - (event.clientX - pan.x) * msPerPx, trend.span);
  });
  const lift = (event: PointerEvent) => {
    if (!fingers.delete(event.pointerId)) return;
    const wasTap = event.type === "pointerup" && pan && pan.mode === null && !pinched && fingers.size === 0;
    begin();
    if (wasTap) tap(event.clientX);
  };
  // On the window: an Ops render moves the chart through a detached wrapper, which drops its pointer capture, so a
  // finger lifted off the chart after that still has to clear here or the next touch would pinch with it.
  listening?.abort();
  listening = new AbortController();
  window.addEventListener("pointerup", lift, { signal: listening.signal });
  window.addEventListener("pointercancel", lift, { signal: listening.signal });
  // The page's pull to refresh (pull-refresh.ts) hears a touch only once it is a vertical swipe: a drag redraws the
  // line it began on, and a pull started under it would never hear the finger lift.
  el.addEventListener(
    "touchmove",
    (event) => {
      if (pinch || (pan && pan.mode !== "scroll")) event.stopPropagation();
    },
    { passive: true },
  );
  // A trackpad: a pinch (wheel with ctrl) zooms about the pointer, a sideways scroll moves through time.
  el.addEventListener(
    "wheel",
    (event) => {
      const { start, end } = windowNow();
      if (event.ctrlKey) {
        event.preventDefault();
        const anchor = timeAt(event.clientX);
        const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, (end - start) * Math.exp(event.deltaY * 0.01)));
        setWindow(anchor - frac(event.clientX) * span + span, span);
      } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        setWindow(end + event.deltaX * (trend.span / (plotWidth() - padLeft - PAD.right)), trend.span);
      }
    },
    { passive: false },
  );
  el.addEventListener("keydown", (event) => {
    const { end } = windowNow();
    const keys: Record<string, () => void> = {
      ArrowLeft: () => setWindow(end - trend.span / 4, trend.span),
      ArrowRight: () => setWindow(end + trend.span / 4, trend.span),
      "+": () => setWindow(end, trend.span / 2),
      "=": () => setWindow(end, trend.span / 2),
      "-": () => setWindow(end, trend.span * 2),
    };
    const act = keys[event.key];
    if (!act) return;
    event.preventDefault();
    act();
  });
}

function build(): HTMLElement {
  const pill = (label: string, onClick: () => void, value: number) =>
    h("button", { class: "ops-filter-btn", attrs: { type: "button", "aria-pressed": "false", "data-use": "machines.trend.filter", "data-use-value": String(value) }, on: { click: onClick } }, label);
  metricPills = METRICS.map((m, i) =>
    pill(m.pill, () => {
      trend.metric = m.id;
      trend.pick = null;
      draw();
    }, i + 1),
  );
  rangePills = RANGES.map((r, i) =>
    pill(r.label, () => {
      trend.span = r.ms;
      trend.end = null;
      trend.pick = null;
      draw();
    }, METRICS.length + i + 1),
  );
  nowBtn = pill("Now", () => {
    trend.end = null;
    draw();
  }, METRICS.length + RANGES.length + 1);
  nowBtn.classList.add("trend-now");
  plot = h("div", { class: "trend-plot", attrs: { tabindex: "0", "aria-label": "Trend chart: drag sideways to move through time, pinch to zoom" } });
  listen(plot);
  caption = h("span", { class: "trend-window" });
  headline = h("span", { class: "ops-sec-line t-info" });
  after = h("div", { class: "trend-after" });
  const el = h(
    "section",
    { class: "ops-sec trend", attrs: { "data-section": "trend", "aria-labelledby": "ops-trend-title" } },
    h("div", { class: "ops-sec-head" }, h("h2", { class: "ops-sec-title", attrs: { id: "ops-trend-title" } }, "Trend"), headline),
    h("div", { class: "ops-sec-body trend-body" },
      h("div", { class: "ops-filter", attrs: { role: "group", "aria-label": "Metric" } }, ...metricPills),
      h("div", { class: "ops-filter trend-ranges", attrs: { role: "group", "aria-label": "Range" } }, ...rangePills, nowBtn),
      plot,
      h("p", { class: "trend-caption" }, caption, h("span", { class: "trend-hint" }, "Drag to scroll · pinch to zoom · tap for values")),
      after,
    ),
  );
  if (typeof ResizeObserver === "function") new ResizeObserver(() => redraw()).observe(plot);
  return el;
}

/** The trend at the top of Machines: the same element on every render, so a drag or pinch under way carries on. */
export function machinesTrend(ops: OpsResponse | null): HTMLElement {
  const built = !root;
  root ??= build();
  // Moving it into the new page drops focus, and keepFocus sees it back in place: the pill or chart takes it back.
  const focused = root.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
  if (focused) queueMicrotask(() => focused.isConnected && document.activeElement !== focused && focused.focus({ preventScroll: true }));
  load(ops?.mac?.at ?? null);
  if (built || chartKey() !== drawnKey) draw();
  return root;
}
