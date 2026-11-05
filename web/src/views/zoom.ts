// The lightbox's zoom and pan maths, kept pure so it can be tested. Content is laid out at its fit size (scale 1)
// and drawn `scale` times bigger with its top-left corner at (x, y) in the stage.

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

export const DOUBLE_TAP_SCALE = 3;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** An image fits inside the stage; a document fills the stage's width up to `maxWidth`, as tall as its pages make it. */
export function fitSize(natural: Size, stage: Size, mode: "contain" | "width", maxWidth = Infinity): Size {
  if (!(natural.w > 0 && natural.h > 0)) return { w: 0, h: 0 };
  const k = mode === "contain" ? Math.min(stage.w / natural.w, stage.h / natural.h) : Math.min(stage.w, maxWidth) / natural.w;
  return { w: natural.w * k, h: natural.h * k };
}

/** Content smaller than the stage on an axis is centred on it; bigger, it can move only until an edge meets the stage's. */
function axis(at: number, length: number, room: number): number {
  return length <= room ? (room - length) / 2 : clamp(at, room - length, 0);
}

export function clampView(view: View, content: Size, stage: Size, maxScale: number): View {
  const scale = clamp(view.scale, 1, Math.max(1, maxScale));
  return { scale, x: axis(view.x, content.w * scale, stage.w), y: axis(view.y, content.h * scale, stage.h) };
}

/** Zooms to `scale` keeping the content under `at` where it is. */
export function zoomAt(view: View, scale: number, at: Point, content: Size, stage: Size, maxScale: number): View {
  const next = clamp(scale, 1, Math.max(1, maxScale));
  const k = next / view.scale;
  return clampView({ scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }, content, stage, maxScale);
}

export function panBy(view: View, dx: number, dy: number, content: Size, stage: Size, maxScale: number): View {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, content, stage, maxScale);
}

const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Two fingers that were at `from` when the pinch began (with the content at `start`) and are now at `to`: the
 * content scales with the fingers' spread, and the point that was between them stays between them as they move.
 */
export function pinchView(start: View, from: [Point, Point], to: [Point, Point], content: Size, stage: Size, maxScale: number): View {
  const spread = distance(from[0], from[1]);
  const scale = clamp(start.scale * (spread > 0 ? distance(to[0], to[1]) / spread : 1), 1, Math.max(1, maxScale));
  const was = middle(from[0], from[1]);
  const now = middle(to[0], to[1]);
  const k = scale / start.scale;
  return clampView({ scale, x: now.x - (was.x - start.x) * k, y: now.y - (was.y - start.y) * k }, content, stage, maxScale);
}

/** A double tap zooms in on the tapped point, or back out to fit when already zoomed in. */
export function doubleTapView(view: View, at: Point, content: Size, stage: Size, maxScale: number): View {
  const zoomed = view.scale > 1.01;
  return zoomAt(view, zoomed ? 1 : Math.min(DOUBLE_TAP_SCALE, maxScale), at, content, stage, maxScale);
}

/** The scale factor for one wheel event: a trackpad pinch sends small deltas with ctrlKey, a mouse wheel big ones. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-clamp(pixels, -50, 50) / 100);
}
