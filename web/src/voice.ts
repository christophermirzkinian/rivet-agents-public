// Read-aloud in the phone's own voice (the browser's speechSynthesis), free and on the device: Australian English
// first, then British, and never any other. A phone with neither stays silent (The owner:
// no "extremely bored American").

import { rivetWords } from "../../src/shared/names.js";

/** The accents read-aloud may use, best first. */
export const VOICE_LANGS = ["en-AU", "en-GB"] as const;
/** Longest piece given to the phone at once: Chrome can stop a long utterance part-way. */
const PIECE_MAX = 250;
/** Lines asked for before the phone has listed its voices wait this long for the list, then are dropped. */
export const VOICES_WAIT_MS = 5_000;
/** iOS speaks only after a first utterance inside a tap. */
const TAP_EVENTS = ["pointerup", "touchend", "click"] as const;
const TEST_LINE = "Hi. This is how I sound reading your messages.";

/**
 * Chat reads new Rivet messages aloud only while this is on, and it starts off (read-aloud on
 * tap). A new key, so a phone that had the old one on starts off too.
 */
const AUTO_SPEAK_KEY = "rivet.speak.auto";

export function autoSpeak(): boolean {
  try {
    return localStorage.getItem(AUTO_SPEAK_KEY) === "1";
  } catch {
    return false;
  }
}

/** Fired on window when the read-aloud switch moves, so a mounted Chat follows Settings. */
export const AUTO_SPEAK_EVENT = "rivet:auto-speak";

export function setAutoSpeak(on: boolean): void {
  try {
    localStorage.setItem(AUTO_SPEAK_KEY, on ? "1" : "0");
  } catch {}
  window.dispatchEvent(new Event(AUTO_SPEAK_EVENT));
}

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance === "function"
    ? window.speechSynthesis
    : null;
}

/** The browser can speak at all; whether it has an accent we use is voiceAvailable(). */
export function canSpeak(): boolean {
  return synth() !== null;
}

const langOf = (voice: SpeechSynthesisVoice) => voice.lang.replace("_", "-").toLowerCase();

/** The voice read-aloud uses: the first accent in VOICE_LANGS the phone has, its on-device voice before a network one. */
export function pickVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  for (const lang of VOICE_LANGS) {
    const matches = voices.filter((voice) => langOf(voice) === lang.toLowerCase());
    const pick = matches.find((voice) => voice.localService) ?? matches[0];
    if (pick) return pick;
  }
  return null;
}

/** The phone has an Australian or British English voice. Until its list arrives this says no, and VOICES_EVENT follows. */
export function voiceAvailable(): boolean {
  const s = synth();
  if (!s) return false;
  watchVoices(s);
  return pickVoice(s.getVoices()) !== null;
}

/** Fired on window when the phone's list of voices changes, so Settings can say whether there is one. */
export const VOICES_EVENT = "rivet:voices";

let watching = false;
let waiting: string[] = [];
let waitTimer = 0;

/** Chrome lists its voices a moment after the page loads: lines asked for before then speak once it has. */
function watchVoices(s: SpeechSynthesis): void {
  if (watching) return;
  watching = true;
  s.addEventListener("voiceschanged", () => {
    window.dispatchEvent(new Event(VOICES_EVENT));
    if (!waiting.length || s.getVoices().length === 0) return;
    const lines = waiting;
    waiting = [];
    window.clearTimeout(waitTimer);
    for (const line of lines) say(line);
  });
}

/** Phone-sized pieces, cut at a sentence end or a space where there is one. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > PIECE_MAX) {
    const head = rest.slice(0, PIECE_MAX);
    const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
    const cut = sentence > 0 ? sentence + 1 : head.lastIndexOf(" ") > 0 ? head.lastIndexOf(" ") : PIECE_MAX;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Queues `text` in the phone's voice; with no Australian or British voice it is skipped in silence. */
export function say(said: string): void {
  const text = rivetWords(said);
  const s = synth();
  if (!s || !text.trim()) return;
  watchVoices(s);
  const voices = s.getVoices();
  if (voices.length === 0) {
    waiting.push(text);
    window.clearTimeout(waitTimer);
    waitTimer = window.setTimeout(() => (waiting = []), VOICES_WAIT_MS);
    return;
  }
  const voice = pickVoice(voices);
  if (!voice) return;
  for (const piece of pieces(text)) {
    const utterance = new SpeechSynthesisUtterance(piece);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    // A failed line is skipped; nothing is shown.
    utterance.onerror = () => undefined;
    try {
      s.speak(utterance);
    } catch {
      return;
    }
  }
}

export function stopVoice(): void {
  waiting = [];
  window.clearTimeout(waitTimer);
  synth()?.cancel();
}

let unlocked = false;

/** iOS speaks only after an utterance made inside a tap: call from a tap handler. Elsewhere it does no harm. */
export function unlockVoice(): void {
  const s = synth();
  if (!s || unlocked) return;
  unlocked = true;
  watchVoices(s);
  try {
    s.speak(new SpeechSynthesisUtterance(""));
  } catch {}
}

/** Unlocks on the next tap. Returns the remover. */
export function unlockOnTap(): () => void {
  const remove = () => {
    for (const type of TAP_EVENTS) document.removeEventListener(type, tap, true);
  };
  const tap = () => {
    unlockVoice();
    remove();
  };
  for (const type of TAP_EVENTS) document.addEventListener(type, tap, true);
  return remove;
}

export function testVoice(): void {
  stopVoice();
  unlockVoice();
  say(TEST_LINE);
}
