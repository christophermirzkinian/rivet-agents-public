import "./mind.css";

import type ForceGraph from "force-graph";

import { MIND_KIND_WORDS, mindMarksGone, type MindDot, type MindGraph, type MindLink, type MindNodeResponse, type MindType } from "../../../src/shared/mind.js";
import { rivetWords } from "../../../src/shared/names.js";
import { when } from "../../../src/shared/when.js";
import * as api from "../api.js";
import { h, keepFocus } from "../dom.js";
import { onSessionReset, sameSession } from "../session.js";

// Rivet's mind, a menu page: every memory, topic, note and decision in the folders you name as one graph to pinch, drag
// and search. force-graph is imported only when this page opens. Labels are drawn after every dot, the biggest first, and
// one that would overlap a drawn one is left out; on screen a hub's is 16 px bold and any other 14 px. Beside the map, a
// list: what is always loaded, then a section per topic A to Z, then what no topic holds. The same search and chips narrow
// it, a row opens the same sheet, and the page opens on whichever view was last picked.

type Dot = MindDot & { r: number; big: boolean; today: boolean; hay: string; x?: number; y?: number; vx?: number; vy?: number };
type Link = { source: string | Dot; target: string | Dot; kind: MindLink["kind"] };
type Graph = ForceGraph<Dot, Link>;
type Mode = "" | "today" | "loaded";
type View = "map" | "list";
type Section = { key: string; label: string; type: MindType; about: Dot | null; rows: Dot[] };

const TYPES: { key: MindType; label: string; tap: string }[] = [
  { key: "feedback", label: "Feedback", tap: "mind.type.feedback" },
  { key: "project", label: "Project", tap: "mind.type.project" },
  { key: "reference", label: "Reference", tap: "mind.type.reference" },
  { key: "user", label: "User", tap: "mind.type.user" },
  { key: "note", label: "Notes", tap: "mind.type.note" },
  { key: "decision", label: "Decisions", tap: "mind.type.decision" },
];
const DAY_MS = 864e5;
const WIDE = 760;
const SEARCH_WAIT_MS = 250;
const VIEW_KEY = "rivet.mind.view";
const EMPTY_NOTE = "Nothing here yet. Set RIVET_MIND_MEMORY_DIR, RIVET_MIND_NOTES_DIR or RIVET_MIND_DECISIONS_DIR on your Mac, then run scripts/install-mind.sh.";

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "map";
  } catch {
    return "map";
  }
}

function saveView(view: View): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Private mode: the choice lasts until the page closes.
  }
}

export const mindData = { graph: null as MindGraph | null, loaded: false, error: false };
let inflight: Promise<void> | null = null;

onSessionReset(() => {
  mindData.graph = null;
  mindData.loaded = false;
  mindData.error = false;
  inflight = null;
  words.clear();
  openSections.clear();
});

export function loadMind(): Promise<void> {
  if (inflight) return inflight;
  const current = sameSession();
  const load = api
    .getMind()
    .then((answer) => {
      if (!current()) return;
      mindData.graph = answer.graph;
      mindData.loaded = true;
      words.clear();
      mindData.error = false;
    })
    .catch(() => {
      if (current()) mindData.error = true;
    })
    .finally(() => {
      if (inflight === load) inflight = null;
    });
  inflight = load;
  return load;
}

/** Each node's words, read on its first tap. */
const words = new Map<string, MindNodeResponse>();
/** The list's open sections: a new map from the Mac replaces the page, not what was open. */
const openSections = new Set<string>();

const fmt = (n: number) => n.toLocaleString("en-AU");

let root: HTMLElement | null = null;
let page: Page | null = null;

export function mount(el: HTMLElement): void {
  unmount();
  root = el;
  paint();
  void loadMind().then(() => {
    if (root === el) paint();
  });
}

export function unmount(): void {
  page?.destroy();
  page = null;
  root = null;
}

export function refresh(): Promise<void> {
  return loadMind().then(() => {
    if (root) paint();
  });
}

function paint(): void {
  if (!root) return;
  const graph = mindData.graph;
  if (!graph || !graph.nodes.length) {
    page?.destroy();
    page = null;
    const note = mindData.error ? "Couldn't load the map. Pull to try again." : !mindData.loaded ? "Loading…" : EMPTY_NOTE;
    root.replaceChildren(h("div", { class: "mind mind-empty" }, h("p", { class: "mind-note" }, note)));
    return;
  }
  if (page?.graph === graph) return;
  page?.destroy();
  page = new Page(root, graph);
}

/** Labels drawn on the last frame, for the preview's checks. */
export function mindLabels(): string[] {
  return page?.labels ?? [];
}

/** Opens a dot's sheet as a tap does, for the preview's stills. */
export function mindSelect(id: string): void {
  page?.select(id);
}

class Page {
  readonly labels: string[] = [];
  private readonly el: HTMLElement;
  private readonly byId: Map<string, Dot>;
  private readonly nbr = new Map<string, Set<string>>();
  private readonly loaded: Set<string>;
  private readonly off = new Set<MindType>();
  private q = "";
  private mode: Mode = "";
  private sel: string | null = null;
  private matches = new Set<string>();
  private queue: { n: Dot; pri: number }[] = [];
  private fg: Graph | null = null;
  private colors: Record<string, string> = {};
  private searchTimer = 0;
  private resize: ResizeObserver | null = null;
  private dead = false;
  private view = savedView();
  private started = false;
  private readonly sections: Section[];
  /** Sections folded by hand while a search or mode has the rest open. */
  private readonly folded = new Set<string>();
  private readonly viewButtons: Record<View, HTMLElement>;
  private readonly input: HTMLInputElement;
  private readonly parts: {
    hits: HTMLElement;
    chips: HTMLElement;
    stage: HTMLElement;
    canvas: HTMLElement;
    list: HTMLElement;
    banner: HTMLElement;
    sheet: HTMLElement;
    zoom: HTMLElement;
  };

  constructor(
    private readonly host: HTMLElement,
    readonly graph: MindGraph,
  ) {
    const nodes = graph.nodes.map((n) => ({ ...n, label: rivetWords(n.label).trim() }) as Dot).sort((a, b) => Number(isHub(b)) - Number(isHub(a)));
    this.byId = new Map(nodes.map((n) => [n.id, n]));
    this.loaded = new Set(graph.loaded);
    const deg = new Map<string, number>();
    for (const l of graph.links)
      for (const [a, b] of [
        [l.source, l.target],
        [l.target, l.source],
      ] as const) {
        deg.set(a, (deg.get(a) ?? 0) + 1);
        if (!this.nbr.has(a)) this.nbr.set(a, new Set());
        this.nbr.get(a)!.add(b);
      }
    const now = Date.now();
    for (const n of nodes) {
      const d = deg.get(n.id) ?? 0;
      n.r = isHub(n) ? 9 + Math.sqrt(d) * 1.1 : 3 + Math.sqrt(d) * 0.7;
      n.big = isHub(n);
      n.today = n.written !== null && now - n.written < DAY_MS;
      n.hay = `${n.label} ${n.id}`.toLowerCase();
    }
    this.sections = this.buildSections();

    const input = h("input", {
      class: "mind-q",
      attrs: { type: "search", placeholder: "Search the map", autocomplete: "off", "aria-label": "Search Rivet's mind", "data-use": "mind.search" },
      on: { input: () => this.search(input.value.trim()) },
    });
    this.parts = {
      hits: h("span", { class: "mind-hits", attrs: { role: "status" } }),
      chips: h("div", { class: "mind-chips", attrs: { role: "group", "aria-label": "Show" } }),
      stage: h("div", { class: "mind-stage" }),
      canvas: h("div", { class: "mind-graph" }),
      list: h("div", { class: "mind-list" }),
      banner: h("div", { class: "mind-banner" }),
      sheet: h("div", { class: "mind-sheet", attrs: { role: "dialog", "aria-label": "About this dot" } }),
      zoom: h("div", { class: "mind-zoom" }),
    };
    const { hits, chips, stage, canvas, list, banner, sheet, zoom } = this.parts;
    this.input = input;
    const viewButton = (view: View, label: string, use: string) => h("button", { class: "mind-view", attrs: { type: "button", "data-use": use }, on: { click: () => this.setView(view) } }, label);
    this.viewButtons = { map: viewButton("map", "Map", "mind.view.map"), list: viewButton("list", "List", "mind.view.list") };
    zoom.append(
      h("button", { class: "mind-zoom-btn", attrs: { type: "button", "aria-label": "Zoom in", "data-use": "mind.zoom-in" }, on: { click: () => this.fg?.zoom(this.fg.zoom() * 1.6, 300) } }, "+"),
      h("button", { class: "mind-zoom-btn", attrs: { type: "button", "aria-label": "Zoom out", "data-use": "mind.zoom-out" }, on: { click: () => this.fg?.zoom(this.fg.zoom() / 1.6, 300) } }, "−"),
      h("button", { class: "mind-zoom-btn", attrs: { type: "button", "aria-label": "Fit the map", "data-use": "mind.fit" }, on: { click: () => this.fit() } }, "⤢"),
    );
    stage.append(canvas, banner, list, sheet, zoom);
    this.el = h(
      "div",
      { class: "mind" },
      h(
        "div",
        { class: "mind-head" },
        h("p", { class: "mind-sub" }, `${fmt(nodes.length)} things · ${fmt(graph.links.length)} links`),
        h("div", { class: "mind-views", attrs: { role: "group", "aria-label": "View" } }, this.viewButtons.map, this.viewButtons.list),
      ),
      h("div", { class: "mind-search" }, input, hits),
      chips,
      stage,
    );
    host.replaceChildren(this.el);
    this.colors = Object.fromEntries([...TYPES.map((t) => t.key), "context"].map((key) => [key, getComputedStyle(this.el).getPropertyValue(`--mind-${key}`).trim() || "#c4bed8"]));
    this.sizeStage();
    this.resize = new ResizeObserver(() => this.sizeStage());
    this.resize.observe(host.parentElement ?? host);
    this.update(false);
    this.showView();
  }

  destroy(): void {
    this.dead = true;
    window.clearTimeout(this.searchTimer);
    this.resize?.disconnect();
    this.fg?._destructor();
    this.fg = null;
  }

  /** The stage fills the page down to the bottom of the scroller it sits in. */
  private sizeStage(): void {
    const scroller = this.host.parentElement ?? this.host;
    const bottom = scroller.getBoundingClientRect().bottom || window.innerHeight;
    const top = this.parts.stage.getBoundingClientRect().top;
    this.parts.stage.style.height = `${Math.max(320, Math.round(bottom - top))}px`;
    this.el.classList.toggle("is-wide", this.el.clientWidth >= WIDE);
    this.fg?.width(this.parts.stage.clientWidth).height(this.parts.stage.clientHeight);
  }

  /** Every thing in one section or more: what is always loaded, the topics A to Z, then what no topic holds. */
  private buildSections(): Section[] {
    const all = [...this.byId.values()];
    const byName = (a: Dot, b: Dot) => a.label.localeCompare(b.label, "en", { numeric: true, sensitivity: "base" });
    const core = new Set<string>();
    const held = new Map<string, Dot[]>();
    const filed = new Set<string>();
    for (const l of this.graph.links) {
      const from = this.byId.get(l.source);
      const to = this.byId.get(l.target);
      if (!from || !to) continue;
      if (l.kind === "loaded" && to.kind === "memory") core.add(to.id);
      if (l.kind !== "hub" && l.kind !== "wikilink") continue;
      // The export keeps one link per pair, of either kind and either way round, so a topic's own list can come as any.
      const [hub, memory] = from.kind === "hub" ? [from, to] : [to, from];
      if (hub.kind !== "hub" || memory.kind !== "memory") continue;
      filed.add(memory.id);
      held.set(hub.id, [...(held.get(hub.id) ?? []), memory]);
    }
    const section = (key: string, label: string, type: MindType, rows: Dot[], about: Dot | null = null): Section => ({ key, label, type, about, rows: rows.sort(byName) });
    const topics = all
      .filter((n) => n.kind === "hub")
      .sort(byName)
      .map((hub) => section(hub.id, hub.label, hub.type as MindType, held.get(hub.id) ?? [], hub));
    return [
      section("core", "Always loaded", "context" as MindType, all.filter((n) => n.kind === "context" || core.has(n.id))),
      ...topics,
      section("loose", "No topic yet", "reference", all.filter((n) => n.kind === "memory" && !filed.has(n.id) && !core.has(n.id))),
      section("notes", "Notes", "note", all.filter((n) => n.kind === "note")),
      section("decisions", "Decisions", "decision", all.filter((n) => n.kind === "decision")),
    ];
  }

  private setView(view: View): void {
    if (view === this.view) return;
    this.select(null);
    this.view = view;
    saveView(view);
    this.showView();
    // What the list narrowed the map shows too; an unnarrowed map stays where it was left.
    if (view === "map") this.update(!!this.q || !!this.mode);
  }

  private showView(): void {
    const list = this.view === "list";
    this.el.classList.toggle("is-list", list);
    this.viewButtons.map.setAttribute("aria-pressed", String(!list));
    this.viewButtons.list.setAttribute("aria-pressed", String(list));
    this.input.placeholder = list ? "Search the list" : "Search the map";
    if (list) {
      this.fg?.pauseAnimation();
      this.renderList();
    } else if (this.fg) this.fg.resumeAnimation();
    else if (!this.started) void this.start([...this.byId.values()]);
  }

  private async start(nodes: Dot[]): Promise<void> {
    this.started = true;
    const { default: ForceGraphClass } = await import("force-graph");
    if (this.dead) return;
    const { stage, canvas } = this.parts;
    const lit = (n: Dot) => this.lit(n);
    const fg: Graph = new ForceGraphClass<Dot, Link>(canvas)
      .width(stage.clientWidth)
      .height(stage.clientHeight)
      .backgroundColor("rgba(0,0,0,0)")
      .graphData({ nodes, links: this.graph.links.map((l) => ({ ...l })) })
      .nodeId("id")
      .nodeVal((n) => n.r * n.r)
      .nodeRelSize(1)
      .nodeVisibility((n) => !this.off.has(n.type as MindType))
      .linkVisibility((l) => !this.off.has(end(l.source).type as MindType) && !this.off.has(end(l.target).type as MindType))
      .linkColor((l) => (lit(end(l.source)) && lit(end(l.target)) && (this.sel || this.q || this.mode) ? "rgba(255,194,61,0.55)" : "rgba(214,205,255,0.10)"))
      .linkWidth((l) => (this.sel && (end(l.source).id === this.sel || end(l.target).id === this.sel) ? 2 : 0.6))
      .d3VelocityDecay(0.3)
      .warmupTicks(260)
      .cooldownTicks(60)
      .enableNodeDrag(true)
      .nodeCanvasObject((n, ctx, k) => this.drawNode(n, ctx, k))
      .nodePointerAreaPaint((n, color, ctx) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, Math.max(n.r, 6), 0, 2 * Math.PI);
        ctx.fill();
      })
      .onNodeClick((n) => this.select(n.id))
      .onBackgroundClick(() => this.select(null))
      .onRenderFramePre(() => {
        this.queue = [];
      })
      .onRenderFramePost((ctx, k) => this.drawLabels(ctx, k));
    this.fg = fg;
    fg.d3Force("charge")!.strength!((n: Dot) => (n.big ? -320 : -22));
    (fg.d3Force("charge") as unknown as { distanceMax(d: number): void }).distanceMax(380);
    // A gentle pull to the middle so loose clusters (decisions) stay on screen, weaker across a tall phone.
    let simNodes: Dot[] = [];
    const aspect = Math.min(1, stage.clientWidth / Math.max(1, stage.clientHeight));
    const gravity = Object.assign(
      (alpha: number) => {
        for (const n of simNodes) {
          const g = n.big ? 0.03 : 0.07;
          n.vx! -= n.x! * g * alpha;
          n.vy! -= n.y! * g * aspect * alpha;
        }
      },
      { initialize: (ns: Dot[]) => (simNodes = ns) },
    );
    fg.d3Force("gravity", gravity);
    const link = fg.d3Force("link") as unknown as { distance(f: (l: Link) => number): typeof link; strength(f: (l: Link) => number): typeof link };
    link.distance((l) => (l.kind === "hub" ? 46 : l.kind === "loaded" ? 90 : 34)).strength((l) => (l.kind === "wikilink" ? 0.15 : 0.5));
    let first = true;
    fg.onEngineStop(() => {
      if (!first) return;
      first = false;
      this.update(false);
      this.fit(0);
    });
    if (this.view === "list") fg.pauseAnimation();
  }

  /** What the search, the mode and the type chips leave showing. */
  private picked(n: Dot): boolean {
    return !this.off.has(n.type as MindType) && (this.q ? this.matches.has(n.id) : this.mode === "today" ? n.today : this.mode === "loaded" ? this.loaded.has(n.id) : true);
  }

  private lit(n: Dot): boolean {
    if (this.sel) return n.id === this.sel || !!this.nbr.get(this.sel)?.has(n.id);
    if (this.q) return this.matches.has(n.id);
    if (this.mode === "today") return n.today;
    if (this.mode === "loaded") return this.loaded.has(n.id);
    return true;
  }

  private drawNode(n: Dot, ctx: CanvasRenderingContext2D, k: number): void {
    const on = this.lit(n);
    ctx.globalAlpha = on ? 1 : 0.12;
    ctx.beginPath();
    ctx.arc(n.x!, n.y!, n.r, 0, 2 * Math.PI);
    ctx.fillStyle = this.colors[n.type] ?? "#c4bed8";
    ctx.fill();
    if (n.big) {
      ctx.lineWidth = 2.5 / k;
      ctx.strokeStyle = "rgba(16,14,25,0.9)";
      ctx.stroke();
    }
    const focus = (!!this.q && this.matches.has(n.id)) || n.id === this.sel;
    if (focus) {
      ctx.lineWidth = 3 / k;
      ctx.strokeStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r + 3 / k, 0, 2 * Math.PI);
      ctx.stroke();
    }
    // Hubs always; the rest once zoomed in or picked out.
    if (on && (n.big || k > 2.6 || focus || this.mode || this.sel))
      this.queue.push({ n, pri: n.id === this.sel ? 9 : focus ? 3 : this.mode && n.kind !== "hub" ? 2.5 : isHub(n) ? 2 : n.big ? 1 : 0 });
    ctx.globalAlpha = 1;
  }

  private drawLabels(ctx: CanvasRenderingContext2D, k: number): void {
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
    this.labels.length = 0;
    const sn = this.sel ? this.byId.get(this.sel) : undefined;
    if (sn) boxes.push({ x0: sn.x! - sn.r - 4 / k, x1: sn.x! + sn.r + 4 / k, y0: sn.y! - sn.r - 4 / k, y1: sn.y! + sn.r });
    // Labels stay whole inside the canvas and clear of the zoom buttons.
    const fg = this.fg;
    const { stage, zoom } = this.parts;
    const tl = fg?.screen2GraphCoords(0, 0);
    const br = fg?.screen2GraphCoords(stage.clientWidth, stage.clientHeight);
    const pad = 4 / k;
    if (fg && zoom.offsetParent) {
      const s = stage.getBoundingClientRect();
      const z = zoom.getBoundingClientRect();
      const a = fg.screen2GraphCoords(z.left - s.left - 6, z.top - s.top - 6);
      const c = fg.screen2GraphCoords(z.right - s.left, z.bottom - s.top);
      boxes.push({ x0: a.x, x1: c.x, y0: a.y, y1: c.y });
    }
    this.queue.sort((a, b) => b.pri - a.pri);
    for (const { n, pri } of this.queue) {
      const px = n.big ? 16 : 14;
      ctx.font = `${n.big ? 700 : 600} ${px / k}px ui-rounded, system-ui, sans-serif`;
      const text = n.label.length > 30 ? `${n.label.slice(0, 28)}…` : n.label;
      const w = ctx.measureText(text).width + 8 / k;
      const lh = (px + 6) / k;
      const y = n.y! + n.r + 3 / k;
      let cx = n.x!;
      if (tl && br && (n.x! < tl.x || n.x! > br.x || n.y! < tl.y || n.y! > br.y)) continue;
      if (tl && br) {
        if (w > br.x - tl.x - 2 * pad) continue;
        cx = Math.min(Math.max(cx, tl.x + pad + w / 2), br.x - pad - w / 2);
      }
      const b = { x0: cx - w / 2, x1: cx + w / 2, y0: y, y1: y + lh };
      if (boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue;
      boxes.push(b);
      this.labels.push(text);
      ctx.fillStyle = "rgba(16,14,25,0.82)";
      ctx.beginPath();
      ctx.roundRect(b.x0, b.y0 - 1 / k, w, lh, 6 / k);
      ctx.fill();
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = n.big || pri > 2 ? "#ffffff" : "#e9e5fb";
      ctx.fillText(text, cx, y + 2 / k);
    }
  }

  /** The names and ids that hold the words at once, then the server's read of every text added to them. */
  private search(q: string): void {
    this.q = q;
    window.clearTimeout(this.searchTimer);
    this.matches = this.localMatches();
    this.update(true);
    this.parts.list.scrollTop = 0;
    if (!q) return;
    this.searchTimer = window.setTimeout(() => {
      void api
        .searchMind(q)
        .then(({ ids }) => {
          if (this.dead || this.q !== q) return;
          for (const id of ids) if (this.byId.has(id) && !this.off.has(this.byId.get(id)!.type as MindType)) this.matches.add(id);
          this.update(true);
        })
        .catch(() => {});
    }, SEARCH_WAIT_MS);
  }

  private localMatches(): Set<string> {
    const found = new Set<string>();
    if (!this.q) return found;
    const q = this.q.toLowerCase();
    for (const n of this.byId.values()) if (!this.off.has(n.type as MindType) && n.hay.includes(q)) found.add(n.id);
    return found;
  }

  private renderChips(): void {
    const all = [...this.byId.values()];
    const chip = (cls: string, use: string, label: string, n: number, onClick: () => void, dot?: string) =>
      h(
        "button",
        { class: cls, attrs: { type: "button", "data-use": use, "aria-pressed": String(/\bis-on\b/.test(cls) || (!!dot && !/\bis-off\b/.test(cls))) }, on: { click: onClick } },
        dot ? h("span", { class: `mind-dot t-${dot}` }) : null,
        label,
        h("span", { class: "mind-n" }, fmt(n)),
      );
    const modes: { key: Exclude<Mode, "">; label: string; tap: string; n: number }[] = [
      { key: "today", label: "Today", tap: "mind.today", n: all.filter((n) => n.today).length },
      { key: "loaded", label: "Loaded now", tap: "mind.loaded", n: this.loaded.size },
    ];
    this.parts.chips.replaceChildren(
      ...modes.map((m) =>
        chip(`mind-chip is-mode${this.mode === m.key ? " is-on" : ""}`, m.tap, m.label, m.n, () => {
          this.mode = this.mode === m.key ? "" : m.key;
          this.update(true);
        }),
      ),
      ...TYPES.map((t) =>
        chip(
          `mind-chip${this.off.has(t.key) ? " is-off" : ""}`,
          t.tap,
          t.label,
          all.filter((n) => n.type === t.key).length,
          () => {
            if (this.off.has(t.key)) this.off.delete(t.key);
            else this.off.add(t.key);
            this.search(this.q);
          },
          t.key,
        ),
      ),
    );
  }

  private renderList(): void {
    if (this.view !== "list") return;
    const { list } = this.parts;
    const narrowed = !!this.q || !!this.mode;
    const row = (key: string, n: Dot, label: string) =>
      h("button", { class: "mind-row", attrs: { type: "button", "data-id": `${key} ${n.id}`, "data-use": "mind.row" }, on: { click: () => this.select(n.id) } }, h("span", { class: `mind-dot t-${n.type}` }), label);
    const parts: HTMLElement[] = [];
    for (const s of this.sections) {
      const rows = s.rows.filter((n) => this.picked(n));
      const about = s.about && this.picked(s.about) ? s.about : null;
      if (!rows.length && !about) continue;
      const open = narrowed ? !this.folded.has(s.key) : openSections.has(s.key);
      parts.push(
        h(
          "button",
          { class: "mind-sec", attrs: { type: "button", "aria-expanded": String(open), "data-key": s.key, "data-use": "mind.section" }, on: { click: () => this.toggleSection(s.key) } },
          h("span", { class: `mind-dot t-${s.type}` }),
          h("span", { class: "mind-sec-name" }, s.label),
          h("span", { class: "mind-n" }, fmt(rows.length)),
          h("span", { class: "mind-sec-mark", attrs: { "aria-hidden": "true" } }, "›"),
        ),
      );
      if (!open) continue;
      if (about) parts.push(row(s.key, about, "About this topic"));
      parts.push(...rows.map((n) => row(s.key, n, n.label)));
    }
    list.replaceChildren(...(parts.length ? parts : [h("p", { class: "mind-note" }, "Nothing here matches.")]));
  }

  private toggleSection(key: string): void {
    const set = this.q || this.mode ? this.folded : openSections;
    if (!set.delete(key)) set.add(key);
    const refocus = keepFocus(this.parts.list);
    this.renderList();
    refocus();
  }

  private renderBanner(): void {
    const { banner } = this.parts;
    const all = [...this.byId.values()];
    if (this.mode === "today") {
      const touched = all.filter((n) => n.today && !this.off.has(n.type as MindType));
      banner.replaceChildren(h("b", {}, "Last 24 hours:"), ` ${fmt(touched.length)} written or changed`);
    } else if (this.mode === "loaded") {
      banner.replaceChildren(h("b", {}, "In Rivet's window now:"), ` ${fmt(this.loaded.size)} of ${fmt(all.length)}: your memory index and what it lists`);
    } else banner.replaceChildren();
    banner.classList.toggle("is-shown", !!this.mode && !this.sel);
  }

  select(id: string | null): void {
    this.sel = id;
    const { sheet, stage } = this.parts;
    const n = id ? this.byId.get(id) : undefined;
    if (!n) {
      sheet.classList.remove("is-open");
      this.update(false);
      return;
    }
    this.paintSheet(n);
    sheet.classList.add("is-open");
    sheet.scrollTop = 0;
    this.update(false);
    if (!words.has(n.id))
      void api
        .getMindNode(n.id)
        .then((said) => {
          // A page a new map replaced keeps nothing: these words are the old map's.
          if (this.dead) return;
          words.set(n.id, said);
          if (this.sel === n.id) this.paintSheet(n);
        })
        .catch(() => {});
    const fg = this.fg;
    if (!fg || this.view === "list") return;
    const wide = this.el.classList.contains("is-wide");
    const z = n.big ? (wide ? 1.6 : 1.5) : Math.max(fg.zoom(), wide ? 2.2 : 2.6);
    const shiftY = wide ? 0 : (stage.clientHeight * 0.29) / z;
    const shiftX = wide ? 190 / z : 0;
    fg.centerAt(n.x! + shiftX, n.y! + shiftY, 500);
    fg.zoom(z, 500);
  }

  private paintSheet(n: Dot): void {
    const said = words.get(n.id);
    const links = [...(this.nbr.get(n.id) ?? [])]
      .map((x) => this.byId.get(x))
      .filter((x): x is Dot => !!x)
      .sort((a, b) => Number(b.big) - Number(a.big) || a.label.localeCompare(b.label));
    const body = said?.body ? plain(said.body) : "";
    const bodyEl = body ? h("p", { class: "mind-body" }, body) : null;
    const more =
      bodyEl && (body.length > 360 || body.split("\n").length > 5)
        ? h("button", { class: "mind-more", attrs: { type: "button", "data-use": "mind.read-all" }, on: { click: () => (bodyEl.classList.add("is-all"), more!.remove()) } }, "Read all")
        : null;
    const parts: (Node | null)[] = [
      h("div", { class: "mind-grab" }),
      h("button", { class: "mind-close", attrs: { type: "button", "aria-label": "Close", "data-use": "mind.close" }, on: { click: () => this.select(null) } }, "×"),
      h("h2", { class: "mind-title" }, n.label),
      h(
        "div",
        { class: "mind-meta" },
        h("span", { class: "mind-tag" }, h("span", { class: `mind-dot t-${n.type}` }), `${MIND_KIND_WORDS[n.kind]} · ${n.type}`),
        n.written ? h("span", { class: "mind-tag" }, `Written ${when(n.written)}`) : null,
        this.loaded.has(n.id) ? h("span", { class: "mind-tag is-in" }, "In the window now") : null,
      ),
      said?.desc ? h("p", { class: "mind-desc" }, plain(said.desc)) : said ? null : h("p", { class: "mind-desc is-waiting" }, "Reading…"),
      bodyEl,
      more,
      h("h3", { class: "mind-lh" }, `Links · ${fmt(links.length)}`),
      h(
        "div",
        { class: "mind-links" },
        ...links
          .slice(0, 40)
          .map((l) =>
            h(
              "button",
              { class: "mind-link", attrs: { type: "button", "data-id": l.id, "data-use": "mind.link" }, on: { click: () => this.select(l.id) } },
              h("span", { class: `mind-dot t-${l.type}` }),
              l.label.length > 40 ? `${l.label.slice(0, 38)}…` : l.label,
            ),
          ),
      ),
    ];
    this.parts.sheet.replaceChildren(...parts.filter((p): p is Node => !!p));
  }

  private update(refit: boolean): void {
    const refocus = keepFocus(this.el);
    this.parts.hits.textContent = this.q ? `${fmt(this.matches.size)} found` : "";
    this.renderChips();
    this.renderBanner();
    const fg = this.fg;
    if (fg) fg.nodeVisibility(fg.nodeVisibility()).linkColor(fg.linkColor()).linkWidth(fg.linkWidth());
    if (refit) {
      this.folded.clear();
      this.renderList();
      this.fit();
    }
    refocus();
  }

  private fit(ms = 500): void {
    if (this.view === "map") this.fg?.zoomToFit(ms, this.el.clientWidth < 500 ? 30 : 60, (n) => this.picked(n));
  }
}

const isHub = (n: MindDot) => n.kind === "hub" || n.kind === "context";
const end = (x: string | Dot) => x as Dot;
/** Markdown read as words: links and wiki links as their text, no bold or code marks. */
const plain = mindMarksGone;
