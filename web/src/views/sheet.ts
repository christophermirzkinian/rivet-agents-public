import { h, inertBehind } from "../dom.js";
import { trackOverlayHistory } from "../overlay-history.js";
import { enterScreen, leaveScreen, useTap } from "../usage.js";
import type { View } from "./view.js";

/** `under` is the entry the pop-up opened on: it takes no entry of its own, so Back over it leaves that one. */
let open: { close(): void; under: unknown } | null = null;

/** How long a sheet takes to slide up, and to slide off the screen as it closes (styles.css `sheet-up`, `sheet-down`). */
const RISE_MS = 260;
const LEAVE_MS = 200;

/**
 * Takes a sheet's backdrop away: the panel slides down and the dim fades, then it goes. It stops being a dialog at once, so nothing finds it open;
 * without animations (tests) or with reduced motion it goes at once.
 */
export function leaveSheet(backdrop: HTMLElement): void {
  const panel = backdrop.firstElementChild;
  if (!(panel instanceof HTMLElement) || !slides(panel)) {
    backdrop.remove();
    return;
  }
  backdrop.classList.add("is-leaving");
  backdrop.inert = true;
  panel.removeAttribute("role");
  panel.removeAttribute("aria-modal");
  const done = () => backdrop.remove();
  panel.addEventListener("animationend", (event) => {
    if (event.target === panel) done();
  });
  setTimeout(done, LEAVE_MS + 100);
}

function slides(panel: HTMLElement): boolean {
  return typeof panel.getAnimations === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Runs `then` once a sheet has slid up (or, `leaving`, off), so work that can wait, such as the home screen's redraw under it,
 * stays out of the frames the slide runs in. Without animations (tests) or with reduced motion it runs at once.
 */
export function afterSlide(then: () => void, leaving = false): void {
  if (!slides(document.body)) return then();
  setTimeout(then, leaving ? LEAVE_MS : RISE_MS);
}

/** Runs `then` once the frame a sheet opened in is on screen, so its slide starts before the work does; at once without motion. */
export function afterFirstFrame(then: () => void): void {
  if (!slides(document.body)) return then();
  requestAnimationFrame(() => setTimeout(then));
}

/**
 * Keeps what a closing sheet shows on it as it slides down. The view unmounts at once; whatever its unmount takes out
 * (Rivet's host, Decide's card slot) is put back, scrolled where it was, so the sheet neither goes blank nor shrinks
 * before it leaves. Its own nodes rather than a copy: laying out a copy of Rivet's chat was most of a close's cost. Run
 * the returned step after the unmount.
 */
function keepStill(content: HTMLElement): () => void {
  const panel = content.parentElement;
  if (!panel || !slides(panel)) return () => {};
  const scrolled = [...content.querySelectorAll("*")].flatMap((el) => (el.scrollTop ? [[el, el.scrollTop] as const] : []));
  const unmounting = new MutationObserver(() => {});
  unmounting.observe(content, { childList: true, subtree: true });
  return () => {
    const changes = unmounting.takeRecords().reverse();
    unmounting.disconnect();
    if (content.parentElement !== panel) return;
    for (const change of changes) {
      for (const node of change.addedNodes) if (node.parentNode === change.target) change.target.removeChild(node);
      for (const node of change.removedNodes) change.target.insertBefore(node, change.nextSibling);
    }
    for (const video of content.querySelectorAll("video")) video.pause();
    if (changes.length) for (const [el, top] of scrolled) el.scrollTop = top;
  };
}

/** The home screen's animations a tall sheet paused, while one is up, and the watch that pauses any it starts. */
let held: Set<Animation> | null = null;
let floorChanges: MutationObserver | null = null;

/**
 * Under a tall sheet the home screen's motion waits: the home screen stays where it is until it closes, so
 * the phone draws only the sheet. By script: a style rule over every home-screen element restyled them all, and their
 * two pseudo-elements, on each open and close. One that starts under the sheet (a redraw's, after the slide) waits too,
 * paused in the redraw's own task before a frame of it is drawn; its animationstart, a frame later, was too late.
 */
function holdFloor(): void {
  const view = document.querySelector("main.view");
  if (held || !view || typeof view.getAnimations !== "function") return;
  held = new Set();
  holdRunning(view);
  floorChanges = new MutationObserver(() => holdRunning(view));
  floorChanges.observe(view, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  document.addEventListener("animationstart", holdStarted, true);
}

function holdRunning(el: Element): void {
  if (!held) return;
  for (const animation of el.getAnimations({ subtree: true })) {
    if (animation.playState !== "running" || held.has(animation)) continue;
    animation.pause();
    held.add(animation);
  }
}

function holdStarted(event: AnimationEvent): void {
  const el = event.target;
  if (el instanceof Element && el.closest("main.view")) holdRunning(el);
}

function releaseFloor(): void {
  if (!held) return;
  floorChanges?.disconnect();
  floorChanges = null;
  document.removeEventListener("animationstart", holdStarted, true);
  for (const animation of held) if (animation.playState === "paused") animation.play();
  held = null;
}

/** A visual viewport this much shorter than the page means a keyboard is up. */
const KEYBOARD_MIN_PX = 120;

/**
 * A phone's keyboard shrinks the visual viewport but not the page (Android Chrome's default), so a pop-up's backdrop
 * fits the part of the screen the keyboard leaves and its text box and buttons stay above it. `--vv-h` is that height and `is-keyboard` marks a keyboard up. Returns the undo.
 */
export function fitAboveKeyboard(backdrop: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const fit = () => {
    backdrop.style.top = `${viewport.offsetTop}px`;
    backdrop.style.height = `${viewport.height}px`;
    backdrop.style.bottom = "auto";
    backdrop.style.setProperty("--vv-h", `${viewport.height}px`);
    backdrop.classList.toggle("is-keyboard", viewport.height < window.innerHeight - KEYBOARD_MIN_PX);
  };
  fit();
  viewport.addEventListener("resize", fit);
  viewport.addEventListener("scroll", fit);
  return () => {
    viewport.removeEventListener("resize", fit);
    viewport.removeEventListener("scroll", fit);
  };
}

/**
 * A bottom sheet with a heading; `body` mounts under it and unmounts when the sheet closes. `action`, such as Discuss
 * this, sits beside Close; `look.cancelFirst` puts Close (a Cancel) on its left instead, and `look.mark` sits before the
 * heading.
 */
export function openSheet(
  title: string,
  body: View,
  closeLabel = "Close",
  action?: HTMLElement,
  look: { className?: string; mark?: HTMLElement; cancelFirst?: boolean; use?: string; closeUse?: string } = {},
): void {
  closeSheet();
  const content = h("div", { class: "sheet-body" });
  const close = h("button", { class: "btn", attrs: { type: "button", "data-use": look.closeUse ?? "sheet.close" }, on: { click: () => closeSheet() } }, closeLabel);
  const heading = h("h2", { class: "sheet-title" }, title);
  const panel = h(
    "div",
    { class: look.className ? `sheet ${look.className}` : "sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": title } },
    look.mark ? h("div", { class: "sheet-head" }, look.mark, heading) : heading,
    content,
    action ? h("div", { class: "sheet-foot" }, ...(look.cancelFirst ? [close, action] : [action, close])) : close,
  );
  const backdrop = h("div", { class: "sheet-backdrop" }, panel);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeSheet();
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeSheet();
  };
  document.addEventListener("keydown", onKey);
  const unfit = fitAboveKeyboard(backdrop);
  document.body.append(backdrop);
  const restore = inertBehind(backdrop);
  body.mount(content);
  const screen = look.use ?? "unknown";
  enterScreen(screen);
  open = {
    under: history.state,
    close() {
      leaveScreen(screen);
      const still = keepStill(content);
      body.unmount();
      still();
      restore();
      unfit();
      leaveSheet(backdrop);
      document.removeEventListener("keydown", onKey);
    },
  };
  close.focus();
}

export function closeSheet(): void {
  open?.close();
  open = null;
}

/**
 * A tall sheet follows a finger dragged down it, and one dragged up off the dock. Letting go past this share of its height, or a
 * flick, carries it on; less springs it back.
 */
const DRAG_SHARE = 1 / 3;
/** A flick: the finger's speed over its last 100 ms, px per ms. */
const FLICK_PX_MS = 0.5;
/** A touch moves this far before it is a drag rather than a tap. */
const DRAG_SLOP_PX = 8;

/**
 * The finger's speed over its last 100 ms, px per ms; down is positive. Times are the events' own (`timeStamp`), so a
 * busy frame that holds the moves back (Rivet's chat mounting under a swipe) does not bunch them up and hide a flick.
 */
function fingerSpeed(y: number, t: number) {
  const points = [{ y, t }];
  return {
    add(y: number, t: number): void {
      points.push({ y, t });
      // The last point from before the window stays, to measure from, unless it is from a hold long before it.
      while (points.length > 2 && t - points[1]!.t >= 100) points.shift();
      if (points.length > 2 && t - points[0]!.t > 200) points.shift();
    },
    speed(): number {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      return last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
    },
  };
}

/** The scroller a touch starts in, up to the panel: a drag moves the sheet only while that is at its top. */
function scrollerAt(target: EventTarget | null, panel: HTMLElement): HTMLElement | null {
  for (let el = target instanceof Element ? target : null; el && el !== panel; el = el.parentElement) {
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

/** Holds the tall sheet at `offset` px below fully open, or lets it go: shut, it slides on down; else it eases home. */
type SheetDrag = { follow(offset: number): void; settle(shut: boolean): void; height(): number };

let tall: { close(fromHistory?: boolean): void; hasHistory(): boolean; drag: SheetDrag } | null = null;
let tallEntries = 0;

/**
 * A tall bottom sheet (the Decide sheet over the map): `body` mounts its own head and close. It closes by Escape, a tap
 * on the backdrop, a drag down (on the handle, or anywhere once its content is at the top) and the phone's Back, which takes it a history entry of its own. An
 * ordinary sheet (the reject popup) opens over it; Escape and Back close that one first. `look.onClose` hears every
 * close, however it came. `look.historyDepth` counts the entries `body` pushed over the sheet's own (a conversation in
 * Rivet's chat): a close that is not Back goes back past them too, so the phone's next Back is not used up.
 */
export function openTallSheet(
  label: string,
  body: View,
  look: { className?: string; onClose?: () => void; historyDepth?: () => number; use?: string } = {},
): void {
  closeTallSheet();
  const entry = ++tallEntries;
  const ours = (state: unknown) => (state as { tallSheet?: number } | null)?.tallSheet === entry;
  const content = h("div", { class: "sheet-body" });
  const handle = h("div", { class: "sheet-handle", attrs: { "aria-hidden": "true" } }, h("span"));
  const panel = h(
    "div",
    { class: `sheet is-tall${look.className ? ` ${look.className}` : ""}`, attrs: { role: "dialog", "aria-modal": "true", "aria-label": label } },
    handle,
    content,
  );
  const backdrop = h("div", { class: "sheet-backdrop is-tall" }, panel);
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let alive = true;
  let historyEntry = false;
  let closeHistory: ((fromHistory: boolean) => void) | undefined;
  // Only the Decide sheet's ways out are told apart.
  const by = (id: "decide.backdrop" | "decide.handle.drag" | "decide.escape" | "decide.back") => look.use === "decide" && useTap(id);
  backdrop.addEventListener("click", (event) => {
    if (event.target !== backdrop) return;
    by("decide.backdrop");
    close();
  });
  const drag: SheetDrag = {
    height: () => panel.offsetHeight || window.innerHeight,
    follow(offset) {
      if (!backdrop.classList.contains("is-dragging")) {
        backdrop.classList.add("is-dragging");
        // An opening slide still running gives way to the finger.
        for (const animation of backdrop.getAnimations?.({ subtree: true }) ?? []) {
          if ((animation as CSSAnimation).animationName?.startsWith("sheet-")) animation.finish();
        }
      }
      const down = Math.max(0, offset);
      panel.style.transform = down ? `translateY(${down}px)` : "";
      backdrop.style.setProperty("--sheet-drag", String(Math.min(1, down / drag.height())));
    },
    settle(shut) {
      backdrop.classList.remove("is-dragging");
      // A drag that closes leaves the panel where the finger let go, so it slides on down from there.
      if (shut) return close();
      panel.style.transform = "";
      backdrop.style.removeProperty("--sheet-drag");
    },
  };
  const lets = (dy: number, speed: number) => (dy > drag.height() * DRAG_SHARE && speed > -FLICK_PX_MS) || speed > FLICK_PX_MS;
  // The sheet's own drag let go: a close is told apart from a swipe-open that slid back.
  const release = (shut: boolean) => {
    if (shut) by("decide.handle.drag");
    drag.settle(shut);
  };
  // A finger anywhere on the sheet drags it, once what it started on is scrolled to its top; a mouse drags the handle.
  let touch: { x: number; y: number; dragging: boolean; speed: ReturnType<typeof fingerSpeed> } | null = null;
  panel.addEventListener(
    "touchstart",
    (event) => {
      const finger = event.touches[0];
      const scroller = scrollerAt(event.target, panel);
      const typing = event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]");
      // A second finger ends a drag: the sheet goes back, rather than staying where the first left it.
      if (touch?.dragging) drag.settle(false);
      touch = event.touches.length === 1 && finger && !typing && !(scroller && scroller.scrollTop > 0)
        ? { x: finger.clientX, y: finger.clientY, dragging: false, speed: fingerSpeed(finger.clientY, event.timeStamp) }
        : null;
    },
    { passive: true },
  );
  panel.addEventListener(
    "touchmove",
    (event) => {
      const finger = event.touches[0];
      if (!touch || !finger) return;
      const dy = finger.clientY - touch.y;
      if (!touch.dragging) {
        const dx = finger.clientX - touch.x;
        if (Math.abs(dy) < DRAG_SLOP_PX && Math.abs(dx) < DRAG_SLOP_PX) return;
        // Up, or sideways, is the content's own scroll.
        if (dy <= Math.abs(dx)) {
          touch = null;
          return;
        }
        touch.dragging = true;
      }
      if (event.cancelable) event.preventDefault();
      touch.speed.add(finger.clientY, event.timeStamp);
      drag.follow(dy);
    },
    { passive: false },
  );
  const touchEnd = (event: TouchEvent) => {
    const was = touch;
    touch = null;
    if (!was?.dragging) return;
    const y = event.changedTouches[0]?.clientY ?? was.y;
    was.speed.add(y, event.timeStamp);
    release(event.type === "touchend" && lets(y - was.y, was.speed.speed()));
  };
  panel.addEventListener("touchend", touchEnd);
  panel.addEventListener("touchcancel", touchEnd);
  let mouse: { id: number; y: number; speed: ReturnType<typeof fingerSpeed> } | null = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") return;
    mouse = { id: event.pointerId, y: event.clientY, speed: fingerSpeed(event.clientY, event.timeStamp) };
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (mouse?.id !== event.pointerId) return;
    mouse.speed.add(event.clientY, event.timeStamp);
    drag.follow(event.clientY - mouse.y);
  });
  const drop = (event: PointerEvent) => {
    if (mouse?.id !== event.pointerId) return;
    const was = mouse;
    mouse = null;
    if (!backdrop.classList.contains("is-dragging")) return;
    was.speed.add(event.clientY, event.timeStamp);
    release(event.type === "pointerup" && lets(event.clientY - was.y, was.speed.speed()));
  };
  handle.addEventListener("pointerup", drop);
  handle.addEventListener("pointercancel", drop);
  const onKey = (event: KeyboardEvent) => {
    // A viewer over the sheet takes its own Escape, and an ordinary sheet over it closes on its own.
    if (event.key !== "Escape" || open || document.querySelector(".lightbox")) return;
    by("decide.escape");
    close();
  };
  const onPop = (event: PopStateEvent) => {
    // Back over the reject popup (or Share) closes the popup alone, on an entry of the sheet's own too (one a chat page
    // inside it pushed); off the sheet's entries, the sheet takes its entry back.
    if (open) {
      const { under } = open;
      closeSheet();
      if (ours(event.state)) {
        // A chat page's entry went with that Back: put it back, and keep Chat (whose listener comes after this one,
        // mounted inside the sheet) from going back a screen under the pop-up.
        event.stopImmediatePropagation();
        try {
          history.pushState(under, "");
        } catch {
          // Without its entry the page stays on screen; Back from it goes a screen further back.
        }
        return;
      }
      try {
        history.pushState({ tallSheet: entry }, "");
      } catch {
        historyEntry = false;
      }
      return;
    }
    // A viewer opened over the sheet going back to the sheet's own entry, or a chat page inside it going back to another.
    if (ours(event.state)) return;
    by("decide.back");
    close(true);
  };

  function close(fromHistory = false): void {
    if (!alive) return;
    alive = false;
    // Read before the body unmounts: its entries are the history state now.
    const depth = fromHistory ? 0 : Math.max(0, look.historyDepth?.() ?? 0);
    closeSheet();
    leaveScreen(screen);
    const still = keepStill(content);
    body.unmount();
    still();
    restore();
    unfit();
    releaseFloor();
    leaveSheet(backdrop);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("popstate", onPop);
    if (tall === handleOf) tall = null;
    // Before Back: a leaveTallSheet `next` may run on its popstate, and must find the sheet's owner told.
    look.onClose?.();
    closeHistory?.(fromHistory);
    if (!fromHistory && historyEntry) {
      historyEntry = false;
      if (depth) history.go(-(1 + depth));
      else history.back();
    }
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  }
  const handleOf = { close, hasHistory: () => historyEntry, drag };

  document.addEventListener("keydown", onKey);
  const unfit = fitAboveKeyboard(backdrop);
  document.body.append(backdrop);
  holdFloor();
  const restore = inertBehind(backdrop);
  try {
    closeHistory = trackOverlayHistory();
    history.pushState({ tallSheet: entry }, "");
    historyEntry = true;
  } catch {
    closeHistory?.(true);
    closeHistory = undefined;
  }
  window.addEventListener("popstate", onPop);
  tall = handleOf;
  const screen = look.use ?? "unknown";
  enterScreen(screen);
  body.mount(content);
}

/**
 * A finger dragged up off `button` (the dock's Decide and Rivet) brings its tall sheet up under it: `button` opens the
 * sheet as the drag starts, the sheet follows the finger, and letting go past a third of the way, or a flick up, opens
 * it fully; less slides it back down and closes it. A tap stays a tap.
 */
export function swipeOpens(button: HTMLElement): void {
  // `sheet`: the tall sheet the press opened, once it is up (the home screen opens it on its next paint).
  let touch: { x: number; y: number; pressed: boolean; before: SheetDrag | null; sheet: SheetDrag | null; speed: ReturnType<typeof fingerSpeed> } | null = null;
  button.addEventListener(
    "touchstart",
    (event) => {
      const finger = event.touches[0];
      // A second finger ends the swipe: the sheet it brought up slides back down.
      if (touch?.sheet && tall?.drag === touch.sheet) touch.sheet.settle(true);
      touch = event.touches.length === 1 && finger
        ? { x: finger.clientX, y: finger.clientY, pressed: false, before: tall?.drag ?? null, sheet: null, speed: fingerSpeed(finger.clientY, event.timeStamp) }
        : null;
    },
    { passive: true },
  );
  button.addEventListener(
    "touchmove",
    (event) => {
      const finger = event.touches[0];
      if (!touch || !finger) return;
      const lift = touch.y - finger.clientY;
      if (!touch.pressed) {
        const dx = finger.clientX - touch.x;
        if (lift < DRAG_SLOP_PX && Math.abs(dx) < DRAG_SLOP_PX) return;
        if (lift <= Math.abs(dx)) {
          touch = null;
          return;
        }
        touch.pressed = true;
        button.click();
      }
      if (event.cancelable) event.preventDefault();
      touch.speed.add(finger.clientY, event.timeStamp);
      if (!touch.sheet && tall && tall.drag !== touch.before) touch.sheet = tall.drag;
      touch.sheet?.follow(touch.sheet.height() - lift);
    },
    { passive: false },
  );
  const end = (event: TouchEvent) => {
    const was = touch;
    touch = null;
    const sheet = was?.sheet;
    if (!was || !sheet) return;
    const y = event.changedTouches[0]?.clientY ?? was.y;
    was.speed.add(y, event.timeStamp);
    const speed = was.speed.speed();
    const opens = event.type === "touchend" && ((was.y - y > sheet.height() * DRAG_SHARE && speed < FLICK_PX_MS) || speed < -FLICK_PX_MS);
    // Only the sheet this drag opened: something else may have closed it already.
    if (tall?.drag === sheet) sheet.settle(!opens);
  };
  button.addEventListener("touchend", end);
  button.addEventListener("touchcancel", end);
}

export function closeTallSheet(): void {
  tall?.close();
}

/** Closes the tall sheet, then runs `next` once its Back has landed, so Back cannot undo where `next` goes. */
export function leaveTallSheet(next: () => void): void {
  if (!tall?.hasHistory()) {
    closeTallSheet();
    return next();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    window.removeEventListener("popstate", run);
    clearTimeout(timer);
    next();
  };
  window.addEventListener("popstate", run);
  timer = setTimeout(run, 400);
  closeTallSheet();
}
