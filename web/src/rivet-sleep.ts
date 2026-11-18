// Rivet Cloud stops an idle Rivet's machine and any request wakes it again, so the app's own timers must not. A request
// sent with no tap, key or return to the app just before it says so (x-rivet-background: 1), and Rivet Cloud does not
// count it as a visit. Once the machine says it is going to sleep (the stream's `asleep` event, or an answer marked
// x-rivet-asleep: 1) background requests stop and the stream stays shut until the next tap, key or return to the app.
// A month's hours used up answers with the cap page's 503 and its day (x-rivet-capped-until), which the open app shows.
// Outside Rivet Cloud nothing sends any of these, and the header is ignored.
import { dayMonth } from "../../src/shared/when.js";

const INPUT_MS = 3000;
// A wake's own loads (the list, the open chat) can wait on the machine's boot: they still go as a visit.
const WAKE_MS = 15_000;

let lastInput = -Infinity;
let wokeAt = -Infinity;
let asleep = false;
const wakers = new Set<() => void>();

function input(): void {
  lastInput = Date.now();
  if (!asleep) return;
  asleep = false;
  wokeAt = lastInput;
  for (const wake of wakers) wake();
}

/** Listens for real input, capturing, so a return to the app wakes before the app's own listeners refresh. */
export function watchInput(doc: Document = document): void {
  doc.addEventListener("pointerdown", input, true);
  doc.addEventListener("keydown", input, true);
  doc.addEventListener(
    "visibilitychange",
    () => {
      if (doc.visibilityState === "visible") input();
    },
    true,
  );
}

export const isAsleep = (): boolean => asleep;

export function fellAsleep(): void {
  asleep = true;
}

/** Runs `wake` at the first real input after a sleep; returns its removal. */
export function onWake(wake: () => void): () => void {
  wakers.add(wake);
  return () => wakers.delete(wake);
}

export const isBackground = (): boolean => {
  const now = Date.now();
  return now - lastInput >= INPUT_MS && now - wokeAt >= WAKE_MS;
};

const NBSP = " ";
/** While capped, "until 1 December" (or "until next month"); null otherwise. */
let capWake: string | null = null;
const capWatchers = new Set<(wake: string | null) => void>();

/** Runs `watch` now and at each change of the cap: its "until …" while capped, null once it lifts; returns its removal. */
export function onCap(watch: (wake: string | null) => void): () => void {
  capWatchers.add(watch);
  watch(capWake);
  return () => capWatchers.delete(watch);
}

function setCap(wake: string | null): void {
  if (wake === capWake) return;
  capWake = wake;
  for (const watch of capWatchers) watch(wake);
}

/** The cap page's message at the top of the app, as the page itself words it; gone at the first answer that is not the cap's. */
function showCap(until: number | null): void {
  const day = until === null ? null : dayMonth(until).replace(" ", NBSP);
  // Watchers hear of it before the band takes its height, so they can see where they were.
  setCap(day === null ? "until next month" : `until ${day}`);
  let note = document.getElementById("rivet-cap");
  if (!note) {
    note = document.createElement("div");
    note.id = "rivet-cap";
    note.setAttribute("role", "status");
    // Beside the body, not in it: the body then holds the app and every sheet below the band (styles.css).
    document.documentElement.insertBefore(note, document.body);
  }
  const heading = document.createElement("strong");
  heading.textContent = `You've used this month's 200${NBSP}hours.`;
  const when = document.createElement("div");
  when.textContent = `Your Rivet wakes again ${day === null ? "at the start of next month" : `on ${day}`}.`;
  note.replaceChildren(heading, when);
}

function clearCap(): void {
  setCap(null);
  document.getElementById("rivet-cap")?.remove();
}

export function heardAnswer(response: Response): void {
  const header = (name: string): string | null => response.headers?.get?.(name) ?? null;
  if (header("x-rivet-asleep") === "1") fellAsleep();
  if (typeof document === "undefined") return;
  if (response.status === 503 && header("x-rivet-asleep") === "1" && header("x-rivet-capped-until") !== null) {
    const until = Number(header("x-rivet-capped-until"));
    showCap(Number.isSafeInteger(until) ? until : null);
  } else if (header("x-rivet-asleep") !== "1") clearCap();
}

/** For tests. */
export function resetSleep(): void {
  lastInput = -Infinity;
  wokeAt = -Infinity;
  asleep = false;
  wakers.clear();
  capWake = null;
  capWatchers.clear();
  if (typeof document !== "undefined") document.getElementById("rivet-cap")?.remove();
}
