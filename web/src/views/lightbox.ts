import "./lightbox.css";

import { h, inertBehind, svg } from "../dom.js";
import { trackOverlayHistory } from "../overlay-history.js";
import { within } from "../within.js";
import { downloadButton, shareButton } from "./share.js";
import { clampView, doubleTapView, fitSize, panBy, pinchView, wheelFactor, zoomAt, type Point, type Size, type View } from "./zoom.js";

// One full-screen viewer for screenshots, chat photos, PDF pages, text files and the Media tab's clips. Zoom and pan happen here, with pointer events and
// the content laid out at its zoomed size, not through the browser's page zoom: an installed iPhone app has none, and
// a laid-out image or a re-rendered page stays sharp where a scaled layer would blur. Escape, the back button or
// Close shut it; focus stays inside while it is open and goes back where it was.

/** What the viewer shows: one image, or a document's pages. */
export interface LightboxContent {
  /** Sized and moved by the viewer. */
  el: HTMLElement;
  /** The content's size at scale 1 in a stage this big; null until it knows its own shape. */
  fit(stage: Size): Size | null;
  maxScale(fit: Size): number;
  /** After every move, and once more with `settled` when the view stops changing; may return a new subtitle. */
  moved?(view: View, fit: Size, stage: Size, settled: boolean): string | void;
  destroy(): void;
}

/** A button under the viewer that leaves it for where the picture came from (the Media tab's Open card, Open chat). */
export interface LightboxAction {
  label: string;
  /** The producer routes this action through leaveOverlays, sharing pending navigation with notifications. */
  run(): void;
}

interface Steps {
  count: number;
  start: number;
  go(index: number): void;
}

const SETTLE_MS = 140;
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 320;
const SWIPE = 60;
const KEY_STEP = 80;
/** An image that has neither loaded nor failed by then says it could not load; a late load still shows it. */
export const IMAGE_LOAD_MS = 30_000;
/** The PDF and text viewers' own code, loaded on first use; a stalled load fails like a bad file. */
export const VIEWER_LOAD_MS = 20_000;
/** An action waits this long for the back the viewer's close took to land, then goes anyway. */
const LEAVE_MS = 400;

const CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

let current: { close(fromHistory?: boolean, replacing?: boolean): void } | null = null;
/** A lightbox history entry is on top, so the back button closes the viewer instead of leaving the app's screen. */
let historyEntry = false;
let closeHistory: ((fromHistory: boolean) => void) | undefined;

const now = () => performance.now();
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

interface Lightbox {
  show(content: LightboxContent | null): void;
  /** Re-reads the content's shape, e.g. once its image has loaded. */
  relayout(): void;
  setTitle(title: string, subtitle?: string): void;
  setNote(text: string): void;
  closed(): boolean;
}

function open(options: {
  label: string;
  kind: "image" | "document" | "video";
  steps?: Steps;
  onClose?: () => void;
  tools?: HTMLElement[];
  action?: LightboxAction;
}): Lightbox {
  current?.close(false, true);
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const title = h("span", { class: "lightbox-title" });
  const subtitle = h("span", { class: "lightbox-sub" });
  const note = h("p", { class: "lightbox-note", attrs: { role: "status" } });
  note.hidden = true;
  const stage = h("div", { class: "lightbox-stage" }, note);
  const tool = (label: string, text: string, run: () => void, extra = "") =>
    h("button", { class: `btn lightbox-tool ${extra}`.trim(), attrs: { type: "button", "data-use": "lightbox.tools", "aria-label": label }, on: { click: run } }, text);
  const closeButton = h(
    "button",
    { class: "btn primary lightbox-close", attrs: { type: "button", "data-use": "lightbox.close" }, on: { click: () => close() } },
    svg(CLOSE, "lightbox-close-icon"),
    "Close",
  );
  const many = (options.steps?.count ?? 0) > 1;
  let at = options.steps?.start ?? 0;
  const step = (by: number) => {
    if (!options.steps) return;
    at = (at + by + options.steps.count) % options.steps.count;
    options.steps.go(at);
  };
  const root = h(
    "div",
    { class: `lightbox ${options.kind}`, attrs: { role: "dialog", "aria-modal": "true", "aria-label": options.label } },
    h(
      "div",
      { class: "lightbox-bar" },
      h("div", { class: "lightbox-heading" }, title, subtitle),
      options.kind === "video" ? null : tool("Zoom out", "−", () => zoomBy(1 / 1.5), "lightbox-zoom"),
      options.kind === "video" ? null : tool("Zoom in", "+", () => zoomBy(1.5), "lightbox-zoom"),
      many ? tool("Previous", "‹", () => step(-1), "lightbox-step") : null,
      many ? tool("Next", "›", () => step(1), "lightbox-step") : null,
      ...(options.tools ?? []),
      closeButton,
    ),
    stage,
    options.action
      ? h(
          "div",
          { class: "lightbox-foot" },
          h("button", { class: "btn lightbox-action", attrs: { type: "button", "data-use": "lightbox.action" }, on: { click: () => options.action!.run() } }, options.action.label),
        )
      : null,
  );

  let content: LightboxContent | null = null;
  let size: Size = { w: 0, h: 0 };
  let fit: Size | null = null;
  let max = 1;
  let view: View = { scale: 1, x: 0, y: 0 };
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let isClosed = false;

  const stopMotion = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const apply = (settled = false) => {
    if (!content || !fit) return;
    const el = content.el;
    el.style.width = `${fit.w * view.scale}px`;
    el.style.height = `${fit.h * view.scale}px`;
    el.style.transform = `translate3d(${view.x}px, ${view.y}px, 0)`;
    const sub = content.moved?.(view, fit, size, settled);
    if (typeof sub === "string") subtitle.textContent = sub;
    clearTimeout(settleTimer);
    if (!settled) settleTimer = setTimeout(() => apply(true), SETTLE_MS);
  };
  const setView = (next: View) => {
    view = next;
    apply();
  };
  const measure = () => {
    size = { w: stage.clientWidth, h: stage.clientHeight };
  };
  const relayout = () => {
    if (!content) return;
    const before = fit;
    measure();
    fit = content.fit(size);
    content.el.style.visibility = fit ? "" : "hidden";
    if (!fit) return;
    max = content.maxScale(fit);
    // A resize (a phone turned on its side) keeps the same part of the content in view.
    const k = before && before.w > 0 ? fit.w / before.w : 1;
    view = clampView({ scale: view.scale, x: view.x * k, y: view.y * k }, fit, size, max);
    apply();
  };
  const animateTo = (target: View) => {
    stopMotion();
    if (reduceMotion()) return setView(target);
    const from = view;
    const start = now();
    const tick = () => {
      const t = Math.min(1, (now() - start) / 220);
      const e = 1 - (1 - t) ** 3;
      setView({ scale: from.scale + (target.scale - from.scale) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e });
      frame = t < 1 ? requestAnimationFrame(tick) : 0;
    };
    frame = requestAnimationFrame(tick);
  };
  const centre = (): Point => ({ x: size.w / 2, y: size.h / 2 });
  const zoomBy = (factor: number, point = centre()) => {
    if (fit) animateTo(zoomAt(view, view.scale * factor, point, fit, size, max));
  };
  const pan = (dx: number, dy: number) => {
    if (fit) setView(panBy(view, dx, dy, fit, size, max));
  };
  const fling = (vx: number, vy: number) => {
    stopMotion();
    let last = now();
    const tick = () => {
      const t = now();
      const dt = Math.min(48, t - last);
      last = t;
      const before = view;
      pan(vx * dt, vy * dt);
      const decay = 0.996 ** dt;
      // An edge stops the fling on that axis.
      vx = view.x === before.x ? 0 : vx * decay;
      vy = view.y === before.y ? 0 : vy * decay;
      frame = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(tick) : 0;
    };
    frame = requestAnimationFrame(tick);
  };

  // Gestures: one pointer pans (and taps), two pinch.
  const pointers = new Map<number, Point>();
  const local = (event: { clientX: number; clientY: number }): Point => {
    const box = stage.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  let pinch: { view: View; from: [Point, Point] } | null = null;
  let drag: { start: Point; last: Point; lastAt: number; startAt: number; vx: number; vy: number; moved: boolean } | null = null;
  let lastTap: { at: Point; time: number } | null = null;
  const startDrag = (point: Point, moved: boolean) => {
    drag = { start: point, last: point, lastAt: now(), startAt: now(), vx: 0, vy: 0, moved };
  };
  const pair = () => [...pointers.values()].slice(0, 2) as [Point, Point];
  stage.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as Element).closest("button, a, video")) return;
    stopMotion();
    stage.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, local(event));
    if (pointers.size === 2) {
      pinch = { view, from: pair() };
      drag = null;
      lastTap = null;
    } else if (pointers.size === 1) {
      startDrag(local(event), false);
    }
  });
  stage.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId) || !fit) return;
    const point = local(event);
    pointers.set(event.pointerId, point);
    if (pinch && pointers.size >= 2) {
      setView(pinchView(pinch.view, pinch.from, pair(), fit, size, max));
      return;
    }
    if (!drag) return;
    if (!drag.moved && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < TAP_SLOP) return;
    drag.moved = true;
    const t = now();
    const dt = Math.max(1, t - drag.lastAt);
    const dx = point.x - drag.last.x;
    const dy = point.y - drag.last.y;
    drag.vx = drag.vx * 0.6 + (dx / dt) * 0.4;
    drag.vy = drag.vy * 0.6 + (dy / dt) * 0.4;
    drag.last = point;
    drag.lastAt = t;
    pan(dx, dy);
  });
  const lift = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size >= 2) {
      // One of three fingers lifted: the pinch goes on from the two still down, from where they are now.
      pinch = { view, from: pair() };
      return;
    }
    if (pointers.size === 1) {
      // The pinch ends; the finger still down carries on panning from where it is.
      pinch = null;
      startDrag(pointers.values().next().value!, true);
      return;
    }
    if (pointers.size > 0 || !drag) return;
    const ended = drag;
    drag = null;
    const point = local(event);
    if (event.type === "pointercancel") return;
    if (!ended.moved) {
      if (now() - ended.startAt > 500) return;
      if (lastTap && now() - lastTap.time < DOUBLE_TAP_MS && Math.hypot(point.x - lastTap.at.x, point.y - lastTap.at.y) < 40) {
        lastTap = null;
        if (fit) animateTo(doubleTapView(view, point, fit, size, max));
      } else {
        lastTap = { at: point, time: now() };
      }
      return;
    }
    const dx = point.x - ended.start.x;
    const dy = point.y - ended.start.y;
    if (many && fit && view.scale <= 1.01 && fit.w <= size.w + 1 && Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.2) {
      step(dx < 0 ? 1 : -1);
      return;
    }
    // A finger that stopped before lifting does not fling.
    if (now() - ended.lastAt < 80 && Math.hypot(ended.vx, ended.vy) > 0.3) fling(ended.vx, ended.vy);
  };
  stage.addEventListener("pointerup", lift);
  stage.addEventListener("pointercancel", lift);

  // A mouse wheel zooms an image and scrolls a document; a trackpad pinch (a wheel with ctrlKey) zooms both.
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (!fit) return;
      stopMotion();
      if (event.ctrlKey || options.kind === "image") {
        setView(zoomAt(view, view.scale * wheelFactor(event.deltaY, event.deltaMode), local(event), fit, size, max));
      } else {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.h : 1;
        pan(-event.deltaX * unit, -event.deltaY * unit);
      }
    },
    { passive: false },
  );
  // Safari's own pinch events: on a Mac trackpad they are the pinch; on an iPhone they come with the pointers, which
  // already zoom, and would otherwise zoom the page.
  let gestureFrom: View | null = null;
  const gesture = (event: Event) => {
    event.preventDefault();
    const g = event as Event & { scale?: number; clientX?: number; clientY?: number };
    if (pointers.size || !fit) return;
    if (event.type === "gesturestart") gestureFrom = view;
    else if (event.type === "gesturechange" && gestureFrom && g.scale) {
      const point = g.clientX === undefined ? centre() : local({ clientX: g.clientX, clientY: g.clientY ?? 0 });
      setView(zoomAt(gestureFrom, gestureFrom.scale * g.scale, point, fit, size, max));
      // zoomAt pins the point against the view the gesture started from, so `gestureFrom` stays put.
    } else if (event.type === "gestureend") gestureFrom = null;
  };
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) root.addEventListener(type, gesture, { passive: false } as AddEventListenerOptions);

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // Once the viewer has gone, the board would take the same Escape as "close the card".
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      // Links too: Tab reaches a Markdown file's links.
      const focusable = [...root.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")].filter((el) => el.offsetParent !== null || el === closeButton);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === "ArrowLeft" && many) step(-1);
    else if (event.key === "ArrowRight" && many) step(1);
    else if (event.key === "+" || event.key === "=") zoomBy(1.5);
    else if (event.key === "-") zoomBy(1 / 1.5);
    else if (event.key === "0" && fit) animateTo(zoomAt(view, 1, centre(), fit, size, max));
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") pan(0, event.key === "ArrowUp" ? KEY_STEP : -KEY_STEP);
    else if (event.key === "PageUp" || event.key === "PageDown" || event.key === " ") {
      event.preventDefault();
      pan(0, (event.key === "PageUp" || (event.key === " " && event.shiftKey) ? 1 : -1) * size.h * 0.9);
    } else return;
  };
  const onPop = () => {
    historyEntry = false;
    close(true);
  };
  const resize = new ResizeObserver(() => relayout());

  function close(fromHistory = false, replacing = false): void {
    if (isClosed) return;
    isClosed = true;
    stopMotion();
    clearTimeout(settleTimer);
    resize.disconnect();
    content?.destroy();
    content = null;
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("popstate", onPop);
    restoreInert();
    root.remove();
    document.documentElement.classList.remove("lightbox-open");
    if (current === handle) current = null;
    options.onClose?.();
    if (!replacing) {
      closeHistory?.(fromHistory);
      closeHistory = undefined;
      if (!fromHistory && historyEntry) {
        historyEntry = false;
        history.back();
      }
      if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    }
  }
  const handle = { close };
  current = handle;

  document.body.append(root);
  const restoreInert = inertBehind(root);
  document.documentElement.classList.add("lightbox-open");
  // Capture: the feed's own keys (left and right answer a card) never see a key meant for the viewer.
  document.addEventListener("keydown", onKey, true);
  if (!historyEntry) {
    closeHistory = trackOverlayHistory();
    try {
      history.pushState({ lightbox: true }, "");
      historyEntry = true;
    } catch (error) {
      closeHistory(true);
      closeHistory = undefined;
      throw error;
    }
  }
  window.addEventListener("popstate", onPop);
  resize.observe(stage);
  closeButton.focus();

  return {
    show(next) {
      stopMotion();
      content?.destroy();
      content = next;
      fit = null;
      view = { scale: 1, x: 0, y: 0 };
      if (!next) return;
      note.hidden = true;
      stage.append(next.el);
      relayout();
    },
    relayout,
    setTitle(text, sub = "") {
      title.textContent = text;
      subtitle.textContent = sub;
    },
    setNote(text) {
      note.textContent = text;
      note.hidden = !text;
    },
    closed: () => isClosed,
  };
}

function imageContent(src: string, alt: string, loaded: () => void, failed: () => void): LightboxContent {
  const img = h("img", { class: "lightbox-img", attrs: { src, alt, draggable: "false", decoding: "async" } });
  const late = setTimeout(failed, IMAGE_LOAD_MS);
  const settled = () => clearTimeout(late);
  img.addEventListener("load", settled);
  img.addEventListener("error", settled);
  img.addEventListener("load", loaded);
  img.addEventListener("error", failed);
  const natural = () => ({ w: img.naturalWidth, h: img.naturalHeight });
  return {
    el: img,
    fit: (stage) => (img.naturalWidth ? fitSize(natural(), stage, "contain") : null),
    // Far enough in to see the original's own pixels on a 3x screen.
    maxScale: (fit) => Math.max(4, (img.naturalWidth / Math.max(1, fit.w)) * 3),
    // A replaced image that fails or loads late says nothing over the one shown now.
    destroy: () => {
      clearTimeout(late);
      img.removeEventListener("load", loaded);
      img.removeEventListener("error", failed);
      img.remove();
    },
  };
}

const IMAGE_FAILED = "Could not load the image.";

/**
 * Images (by URL) full screen, from `index`; the arrows, a swipe or the arrow keys move through them. With `share`
 * (a card's pictures) Download saves the one showing and Share hands it to the share sheet; `share` fetches image `i`
 * as a File.
 */
export function openImages(
  srcs: string[],
  index: number,
  label = "Screenshot",
  share?: (i: number, signal: AbortSignal) => Promise<File | string>,
  action?: LightboxAction,
): void {
  const controller = new AbortController();
  let at = index;
  /** The image showing failed to load: Share clearing its own message puts that back, never a blank viewer. */
  let broken = false;
  const say = (text: string) => box.setNote(text || (broken ? IMAGE_FAILED : ""));
  const sharing = share
    ? shareButton({
        get: () => share(at, controller.signal),
        label: "Share",
        noun: "picture",
        fallback: "download",
        live: () => !box.closed(),
        className: "lightbox-share",
        say,
        hint: true,
      })
    : null;
  const saving = share
    ? downloadButton({ get: () => share(at, controller.signal), label: "Download", noun: "picture", live: () => !box.closed(), className: "lightbox-share", say })
    : null;
  const go = (i: number) => {
    at = i;
    broken = false;
    sharing?.reset();
    saving?.reset();
    box.setTitle(srcs.length > 1 ? `${label} ${i + 1} of ${srcs.length}` : label);
    box.setNote("");
    box.show(
      imageContent(
        srcs[i]!,
        srcs.length > 1 ? `${label} ${i + 1} of ${srcs.length}` : label,
        () => {
          // A picture that comes after its deadline is no longer broken.
          broken = false;
          box.setNote("");
          box.relayout();
        },
        () => {
          broken = true;
          box.setNote(IMAGE_FAILED);
        },
      ),
    );
  };
  const box = open({
    label,
    kind: "image",
    steps: { count: srcs.length, start: index, go },
    onClose: () => controller.abort(),
    tools: sharing && saving ? [saving.button, sharing.button] : [],
    action,
  });
  go(index);
}

function videoContent(src: string, poster: string | undefined, label: string, loaded: () => void, failed: () => void): LightboxContent {
  const video = h("video", { class: "lightbox-video", attrs: { src, controls: "", playsinline: "", preload: "metadata", "aria-label": label, ...(poster ? { poster } : {}) } });
  video.addEventListener("loadedmetadata", loaded);
  video.addEventListener("error", failed);
  return {
    el: video,
    fit: (stage) => (video.videoWidth ? fitSize({ w: video.videoWidth, h: video.videoHeight }, stage, "contain") : null),
    maxScale: () => 1,
    destroy: () => {
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("error", failed);
      video.pause();
      video.remove();
    },
  };
}

/**
 * A clip full screen, playing with sound and its own controls (the Media tab's; a card's clips play in place). `share`
 * fetches it as a File for Download and Share, as a card clip's do.
 */
export function openVideo(src: string, poster: string | undefined, label: string, share: (signal: AbortSignal) => Promise<File | string>, action?: LightboxAction): void {
  const controller = new AbortController();
  const sharing = shareButton({
    get: () => share(controller.signal),
    label: "Share",
    noun: "clip",
    fallback: "download",
    live: () => !box.closed(),
    className: "lightbox-share",
    say: (text) => box.setNote(text),
    hint: true,
  });
  const saving = downloadButton({ get: () => share(controller.signal), label: "Download", noun: "clip", live: () => !box.closed(), className: "lightbox-share", say: (text) => box.setNote(text) });
  const box = open({ label, kind: "video", onClose: () => controller.abort(), tools: [saving.button, sharing.button], action });
  box.setTitle(label);
  const content = videoContent(
    src,
    poster,
    label,
    () => {
      box.setNote("");
      box.relayout();
    },
    () => box.setNote("Could not play the clip."),
  );
  box.show(content);
  void (content.el as HTMLVideoElement).play?.()?.catch(() => {});
}

/**
 * A document full screen, with Download and Share for the file it shows. `share` says, at open and again at every tap,
 * whether it may leave the app (an app-only conversation's file may not): no Share when it says no at open, and a tap
 * after it turns no shares nothing and takes the button away. `get` fetches it (or hands back the copy already kept),
 * or says why it could not; `build` lays it out.
 */
function openDocument(
  name: string,
  get: () => Promise<File | string>,
  build: (file: File, signal: AbortSignal) => Promise<LightboxContent>,
  notes: { getting: string; failed: (shares: boolean) => string },
  share: () => boolean,
): void {
  const controller = new AbortController();
  // One download for the viewer, Download and Share; one that failed is tried again by the next tap.
  let kept: File | null = null;
  let coming: Promise<File | string> | null = null;
  const fetchOnce = () =>
    (coming ??= get().then((got) => {
      if (got instanceof File) kept = got;
      else coming = null;
      return got;
    }));
  const noun = name.toLowerCase().endsWith(".pdf") ? "PDF" : "file";
  const live = () => !box.closed();
  const say = (text: string) => box.setNote(text);
  const saving = downloadButton({ get: fetchOnce, peek: () => kept, label: `Download ${name}`, noun, live, className: "lightbox-share", say });
  const allowed = () => {
    if (share()) return true;
    // Removed, not hidden: .btn's display would show a hidden one.
    sharing?.button.remove();
    say(STAYS_IN_APP);
    return false;
  };
  const sharing = share()
    ? shareButton({ get: fetchOnce, peek: () => kept, label: `Share ${name}`, noun, fallback: "download", live: () => live() && allowed(), className: "lightbox-share", say, hint: true })
    : null;
  const box = open({ label: name, kind: "document", onClose: () => controller.abort(), tools: sharing ? [saving.button, sharing.button] : [saving.button] });
  box.setTitle(name);
  box.setNote(notes.getting);
  void (async () => {
    const file = await fetchOnce();
    if (box.closed()) return;
    if (typeof file === "string") return box.setNote(file);
    try {
      const content = await build(file, controller.signal);
      if (box.closed()) return content.destroy();
      box.show(content);
    } catch {
      // Share only when this viewer has the button and the conversation still lets it out.
      if (!box.closed()) box.setNote(notes.failed(sharing !== null && sharing.button.isConnected && share()));
    }
  })();
}

/** What a document's viewer says when its conversation turned app-only while it was open: Share sends nothing. */
export const STAYS_IN_APP = "This conversation is personal now: it stays in the app.";

/** A PDF's pages full screen; `share` saying no leaves out Share (see openDocument). */
export function openPdf(name: string, get: () => Promise<File | string>, share: () => boolean = () => true): void {
  openDocument(
    name,
    get,
    async (file, signal) => {
      const [{ pdfContent }, data] = await Promise.all([
        within(import("./pdf-pages.js"), VIEWER_LOAD_MS, "PDF viewer took too long to load"),
        file.arrayBuffer(),
      ]);
      signal.throwIfAborted();
      return pdfContent(new Uint8Array(data), signal);
    },
    // Worked out when it fails, not at open: a conversation turned app-only meanwhile has no Share to point at.
    { getting: "Getting the PDF…", failed: (shares) => `Could not show the PDF. ${shares ? "Share" : "Download"} it to open it elsewhere.` },
    share,
  );
}

/** A text file full screen: Markdown formatted, anything else as it is, JSON laid out. */
export function openText(name: string, markdown: boolean, get: () => Promise<File | string>, share: () => boolean = () => true): void {
  openDocument(name, get, async (file) => (await within(import("./text-pages.js"), VIEWER_LOAD_MS, "Text viewer took too long to load")).textContent(file, markdown), {
    getting: "Getting the file…",
    failed: () => "Could not show the file.",
  }, share);
}

/** Closes the viewer, if one is open. */
export function closeLightbox(): void {
  current?.close();
}

/** Closes the viewer, then runs `next` once the back its close took has landed, so it cannot undo a screen `next` opens. */
export function leaveLightbox(next: () => void): void {
  if (!historyEntry) {
    current?.close();
    return next();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    window.removeEventListener("popstate", run);
    clearTimeout(timer);
    next();
  };
  window.addEventListener("popstate", run);
  timer = setTimeout(run, LEAVE_MS);
  current?.close();
}
