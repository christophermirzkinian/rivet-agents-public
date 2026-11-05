import "./rivet.css";

import { IN_HAND, NEEDS_YOU, NOTHING_NEEDS_YOU, stageWord } from "../../../src/shared/words.js";

/**
 * Rivet: a rounded square with a visor for a face and a symbol on his front. He never has arms or legs; he hovers,
 * blinks and looks around, and his eyes and front say how things are.
 */
export type Mood = "clear" | "happy" | "working" | "thinking" | "asking" | "wrong";

export const MOODS: readonly Mood[] = ["clear", "happy", "working", "thinking", "asking", "wrong"];

/** What each mood means, in his words: the caption under him where one is shown. */
export const MOOD_WORDS: Record<Mood, string> = {
  clear: NOTHING_NEEDS_YOU,
  happy: stageWord("done"),
  working: IN_HAND.building,
  thinking: "Thinking",
  asking: NEEDS_YOU,
  wrong: "Something broke",
};

export const EYES: Record<Mood, string> = {
  // Round eyes; chevrons when happy; flat squints when thinking; one raised when asking.
  clear: `<circle cx="37" cy="38" r="7.5"/><circle cx="63" cy="38" r="7.5"/>`,
  working: `<circle cx="37" cy="38" r="7.5"/><circle cx="63" cy="38" r="7.5"/>`,
  happy: `<path class="rv-line" d="M30 42 37 34 44 42M56 42 63 34 70 42"/>`,
  thinking: `<path class="rv-line" d="M30 39H44M56 39H70"/>`,
  asking: `<circle cx="37" cy="39" r="6.5"/><circle cx="63" cy="37" r="8.5"/>`,
  wrong: `<path class="rv-line" d="M31 33 43 43M43 33 31 43M57 33 69 43M69 33 57 43"/>`,
};

/**
 * The symbol on his front, in absolute path commands only (the bounds test reads them). Every symbol sits wholly in
 * the yellow below the visor, never touching it.
 */
export const FRONT: Record<Mood, string> = {
  clear: `<path class="rv-mark" d="M37 72 46 81 64 63"/>`,
  happy: `<path class="rv-mark" d="M37 72 46 81 64 63"/>`,
  working: `<g class="rv-dots"><circle cx="38" cy="73" r="4.5"/><circle cx="50" cy="73" r="4.5"/><circle cx="62" cy="73" r="4.5"/></g>`,
  thinking: `<g class="rv-dots"><circle cx="38" cy="73" r="4.5"/><circle cx="50" cy="73" r="4.5"/><circle cx="62" cy="73" r="4.5"/></g>`,
  asking: `<path class="rv-mark" d="M44 67C44 63.5 46.7 61.5 50 61.5S56 63.5 56 66.7C56 70.7 50 70.9 50 75.3"/><circle class="rv-fill" cx="50" cy="84" r="3.6"/>`,
  wrong: `<path class="rv-mark" d="M41 64 59 82M59 64 41 82"/>`,
};

/** Rivet's geometry in the 100-unit viewBox: the visor and his body, which the symbols are held inside. */
export const VISOR = { x: 17, y: 22, width: 66, height: 32, rx: 16 } as const;
export const BODY = { x: 6, y: 6, width: 88, height: 88, rx: 27, stroke: 4 } as const;
/** The stroke width of a front mark (.rv-mark in rivet.css). */
export const MARK_STROKE = 7.5;

/**
 * Rivet at `mood`; `tone` "agent" draws a sub-agent: the same square, another colour, a smaller front. What moves
 * (the eyes, and the working dots) is drawn on HTML layers over the still body, so the phone's compositor runs the
 * blink, the glance and the dots: an animation inside an SVG repaints it on the main thread every frame.
 */
export function rivetSvg(mood: Mood, tone: "rivet" | "agent" = "rivet"): string {
  const front = tone === "rivet" ? FRONT[mood] : "";
  const dots = front.startsWith(`<g class="rv-dots">`) ? (front.match(/<circle\b[^>]*\/>/g) ?? []) : [];
  return `<svg class="rv-base" viewBox="0 0 100 100" aria-hidden="true">
<rect class="rv-body" x="${BODY.x}" y="${BODY.y}" width="${BODY.width}" height="${BODY.height}" rx="${BODY.rx}"/>
<rect class="rv-visor" x="${VISOR.x}" y="${VISOR.y}" width="${VISOR.width}" height="${VISOR.height}" rx="${VISOR.rx}"/>
${front && !dots.length ? `<g class="rv-front">${front}</g>` : ""}
</svg>
<div class="rv-eyes"><div class="rv-look"><svg viewBox="0 0 100 100" aria-hidden="true">${EYES[mood]}</svg></div></div>
${dots.map((dot, i) => `<svg class="rv-dot rv-dot-${i}" viewBox="0 0 100 100" aria-hidden="true">${dot}</svg>`).join("")}`;
}

/** Rivet in an element of his own, hovering, blinking and, while working, looking around. */
export function rivet(mood: Mood, opts: { size?: number; tone?: "rivet" | "agent"; className?: string; glow?: boolean } = {}): HTMLElement {
  const el = document.createElement("div");
  el.className = `rivet is-${mood} is-${opts.tone ?? "rivet"}${opts.glow ? " has-glow" : ""}${opts.className ? ` ${opts.className}` : ""}`;
  if (opts.size) el.style.setProperty("--rv-size", `${opts.size}px`);
  el.innerHTML = `<div class="rivet-hover">${rivetSvg(mood, opts.tone)}</div>`;
  return el;
}

/** Changes his mood in place: the face squashes and comes back with the new one. */
export function setMood(el: HTMLElement, mood: Mood): void {
  for (const one of MOODS) el.classList.toggle(`is-${one}`, one === mood);
  const tone = el.classList.contains("is-agent") ? "agent" : "rivet";
  const hover = el.querySelector(".rivet-hover");
  if (!hover) return;
  hover.innerHTML = rivetSvg(mood, tone);
  el.classList.remove("is-pop");
  void el.offsetWidth;
  el.classList.add("is-pop");
}
