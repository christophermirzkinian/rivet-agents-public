import { APP_NAME } from "../../src/shared/names.js";
import { h, svg } from "./dom.js";
import { flash } from "./views/toast.js";

// Voice typing: the mic writes into a text field as editable text and never sends it.
// The phone's own speech recognition (Android Chrome's) writes as the owner speaks, interim
// words included. Where the browser has none, the keyboard's own
// mic is the way.

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}

type RecognitionClass = new () => Recognition;

type Field = HTMLTextAreaElement | HTMLInputElement;

export const MIC =
  '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
export const STOP = '<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor"/></svg>';

/** No words for this long and the browser's dictation turns itself off. */
export const IDLE_MS = 60_000;
/** This many ends inside the window with nothing heard means the browser keeps refusing: stop, never spin. */
const RESTARTS = 5;
const RESTART_WINDOW_MS = 3_000;

let active: { stop(): void } | null = null;
// A field keeps its selection when focus moves to the mic (Tab then Enter), so
// once the owner has been in it, that is where the words go; otherwise at the end.
const visited = new WeakSet<Field>();

// Mobile engines (Android Chrome, iOS) report each result as the whole transcript so
// far, repeats and revisions included: ["can do a review", "Can do a review", "can do a
// review of"]. Desktop Chrome reports the new words only, spaced from the piece before:
// ["can do", " a review", " of"]. A piece that starts with everything heard so far
// (ignoring case and spacing), or that no space separates from the piece before, is the
// whole text so far; any other piece adds to it. So a desktop piece that exactly repeats
// the words before it is written once.
const plain = (text: string) => text.replace(/\s+/g, " ").trim();

// Whether a piece starts with the words so far. A mobile interim can stop mid-word
// ("can do a revie"), but a single word must end where it did ("hello" then "hello."
// repeats; "I" then "insist" is two words).
const repeats = (part: string, text: string) =>
  part.toLowerCase().startsWith(text.toLowerCase()) && (text.includes(" ") || !/[\p{L}\p{N}]/u.test(part.charAt(text.length)));

/** The words heard so far in one recognition, once each whichever way the browser reports them. */
export function heardText(results: ArrayLike<ArrayLike<{ transcript: string }>>): string {
  let text = "";
  let previous = "";
  for (const result of Array.from(results)) {
    const raw = result[0]?.transcript ?? "";
    const part = plain(raw);
    if (!part) continue;
    const spaced = /^\s/.test(raw) || /\s$/.test(previous);
    text = !text || !spaced || repeats(part, text) ? part : `${text} ${part}`;
    previous = raw;
  }
  return text;
}

/** Which engine the next dictation uses: the phone's, or none (the keyboard's mic only). */
export function speechEngine(): "phone" | null {
  return recognitionClass(window) ? "phone" : null;
}

function recognitionClass(from: Window): RecognitionClass | null {
  const w = from as Window & { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// WebKit marks the page as using the microphone from a recognition's first audio until
// the document that made it goes away: abort and the end never clear it
// (Document::setActiveSpeechRecognition), so Safari on the Mac can show the mic on
// after Off. Each dictation makes its recognitions in a hidden frame of its own and
// removes the frame at Off, which ends them and clears it.
function listeningFrame(): { Recognition: RecognitionClass; remove(): void } {
  const frame = h("iframe", { class: "dictate-frame", attrs: { "aria-hidden": "true", tabindex: "-1" } });
  // The hidden attribute, not an inline style: the CSP's style-src 'self' drops those.
  frame.hidden = true;
  document.body.append(frame);
  const own = frame.contentWindow ? recognitionClass(frame.contentWindow) : null;
  return { Recognition: own ?? recognitionClass(window)!, remove: () => frame.remove() };
}

/** Ends whichever field is listening, keeping what it wrote. */
export function stopDictation(): void {
  active?.stop();
}

export interface Dictation {
  /** Starts listening into the field, or stops it if it is listening. */
  toggle(): void;
  /** Starts listening into the field unless it is already: a hold-to-talk press. */
  start(): void;
  /** Stops this field's dictation, keeping what it wrote. */
  stop(): void;
}

/**
 * Voice typing into one field, or null where the browser cannot recognise speech. Once on
 * it stays on across pauses until the owner taps again, sends, types, leaves the field, or the
 * app goes to the background; it also stops after a minute with no words. The words go in
 * at the cursor and fire the field's input event. `display` is told while the mic listens.
 * The screen stays on while it listens.
 */
export function dictation(field: Field, display: (listening: boolean) => void): Dictation | null {
  if (!recognitionClass(window)) return null;
  const show = (listening: boolean) => {
    keepAwake(field, listening);
    display(listening);
  };
  field.addEventListener("focus", () => visited.add(field));
  let session: { stop(): void } | null = null;

  // The browser's engine.
  const recognise = () => {
    stopDictation();
    const frame = listeningFrame();
    const placed = visited.has(field) || document.activeElement === field;
    if (document.activeElement !== field) field.focus();
    const at = placed ? (field.selectionStart ?? field.value.length) : field.value.length;
    const to = placed ? (field.selectionEnd ?? at) : field.value.length;
    let before = field.value.slice(0, at);
    let picked = field.value.slice(at, to);
    const after = field.value.slice(to);
    const trail = after && !/^[\s.,!?;:]/.test(after) ? " " : "";
    let lead = "";
    let recognition: Recognition;
    let writing = false;
    // Whether the words between `before` and `after` came from the current recognition.
    let heard = false;
    let ends: number[] = [];
    let idle = 0;
    // What the field holds after dictation's last write. Anything else means the app
    // changed it (a Send clearing the box), so the words so far no longer belong there.
    let expected = field.value;
    // Nothing heard (or an interim guess withdrawn) puts back any text the words were replacing.
    const write = (spoken: string) => {
      const text = spoken ? lead + spoken + trail : picked;
      const room = field.maxLength > 0 ? field.maxLength - before.length - after.length : Infinity;
      const inserted = text.length > room ? text.slice(0, Math.max(0, room)).trimEnd() : text;
      field.value = before + inserted + after;
      expected = field.value;
      heard = spoken !== "";
      const caret = before.length + inserted.length;
      field.setSelectionRange(caret, caret);
      writing = true;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      writing = false;
    };
    const quiet = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(stop, IDLE_MS);
    };
    // Typing, leaving the field or the field going away ends dictation and keeps what is there.
    const typed = () => writing || stop();
    const gone = new MutationObserver(() => field.isConnected || stop());
    // The app going to the background (another tab, the home screen) ends it too.
    const hidden = () => document.hidden && stop();
    const detach = () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
    };
    const stop = () => {
      if (session !== current) return;
      session = null;
      if (active === current) active = null;
      detach();
      window.clearTimeout(idle);
      field.removeEventListener("input", typed);
      field.removeEventListener("blur", stop);
      gone.disconnect();
      document.removeEventListener("visibilitychange", hidden);
      recognition.abort();
      frame.remove();
      show(false);
    };
    const current = { stop };
    const listen = (first = false) => {
      // Whatever is on screen, a last interim guess included, stays: the next
      // recognition's results start from nothing, so they go after those words.
      if (heard) {
        const kept = field.value.slice(before.length, field.value.length - after.length);
        const spaced = trail !== "" && kept.endsWith(trail);
        before += spaced ? kept.slice(0, -trail.length) : kept;
        picked = spaced ? trail : "";
        heard = false;
      }
      lead = before && !/\s$/.test(before) ? " " : "";
      recognition = new frame.Recognition();
      recognition.lang = navigator.language || "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        if (field.value !== expected) return stop();
        ends = [];
        quiet();
        write(heardText(event.results));
      };
      recognition.onerror = (event) => {
        // No words in a pause, or a recognition cut short, is how iOS ends one; the end
        // that follows starts the next. Anything else is a real failure.
        if (event.error === "no-speech" || event.error === "aborted") return;
        if (event.error === "not-allowed") flash(`Allow the microphone for ${APP_NAME} to dictate here.`, "error");
        else phoneFailed();
        stop();
      };
      recognition.onend = () => {
        detach();
        if (field.value !== expected) return stop();
        const now = Date.now();
        ends = [...ends.filter((end) => now - end < RESTART_WINDOW_MS), now];
        if (ends.length >= RESTARTS) return stop();
        listen();
      };
      try {
        recognition.start();
      } catch {
        // Refused at the press says nothing; refused on a restart says it stopped.
        stop();
        if (!first) phoneFailed();
      }
    };
    field.addEventListener("input", typed);
    field.addEventListener("blur", stop);
    gone.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("visibilitychange", hidden);
    session = current;
    active = current;
    show(true);
    quiet();
    listen(true);
  };

  const start = () => (speechEngine() ? recognise() : flash("Tap the microphone on your keyboard to dictate."));

  return {
    toggle: () => (session ? session.stop() : start()),
    start: () => session || start(),
    stop: () => session?.stop(),
  };
}

// The screen stays on while a field listens, so the owner can set the phone down and keep talking.
// Where the browser has no wake lock nothing changes. The lock drops when
// the app goes to the background; back while still listening, it is asked for again.
let awakeFor: Field | null = null;
let lock: Promise<WakeLockSentinel | null> | null = null;
let watching = false;

function keepAwake(field: Field, on: boolean): void {
  if (on) {
    // Added on first use: the module also loads where there is no document (tests).
    if (!watching) {
      watching = true;
      document.addEventListener("visibilitychange", () => awakeFor && askAwake());
    }
    awakeFor = field;
    askAwake();
  } else if (awakeFor === field) {
    awakeFor = null;
    const held = lock;
    lock = null;
    void held?.then((sentinel) => sentinel?.release().catch(() => undefined));
  }
}

function askAwake(): void {
  if (lock || document.hidden || !("wakeLock" in navigator)) return;
  const asked: Promise<WakeLockSentinel | null> = navigator.wakeLock.request("screen").then(
    (sentinel) => {
      sentinel.addEventListener("release", () => lock === asked && (lock = null));
      return sentinel;
    },
    () => {
      if (lock === asked) lock = null;
      return null;
    },
  );
  lock = asked;
}

/** The phone's engine failed (no network for it, no speech service). */
function phoneFailed(): void {
  flash("Your phone's voice typing stopped. Tap the mic to try again.", "error");
}

/**
 * The field with a mic button beside it, or the field alone where the browser cannot
 * recognise speech (the keyboard's own dictation still works there). Nothing is sent.
 */
/** `use` is the mic's What you used id. */
export function withMic(field: Field, use = "dictation.mic"): HTMLElement {
  const label = field.getAttribute("aria-label") ?? "text";
  const status = h("p", { class: "dictate-status", attrs: { role: "status" } });
  status.hidden = true;
  const mic = h("button", {
    class: "btn dictate-mic",
    attrs: { type: "button", "aria-label": `Dictate ${label}`, "aria-pressed": "false", "data-use": use },
    // Keeps the caret in the field, so the tap neither blurs it nor moves the insert point.
    // Not pointerdown: WebKit drops the tap's click when that is prevented.
    on: { mousedown: (event) => event.preventDefault() },
  });
  const wrap = h("div", { class: "dictate" }, field, mic, status);

  const show = (listening: boolean) => {
    mic.replaceChildren(svg(listening ? STOP : MIC, "dictate-icon"));
    mic.classList.toggle("listening", listening);
    mic.setAttribute("aria-pressed", String(listening));
    mic.setAttribute("aria-label", listening ? "Stop dictation" : `Dictate ${label}`);
    wrap.classList.toggle("listening", listening);
    status.hidden = !listening;
    status.textContent = listening ? "Listening… tap the mic to stop" : "";
  };
  const voice = dictation(field, show);
  if (!voice) return field;
  show(false);
  mic.addEventListener("click", voice.toggle);
  return wrap;
}
