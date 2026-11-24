const traversals = new WeakSet<PopStateEvent>();
const trackers = new Set<(event: PopStateEvent) => void>();

/** Told apart from an entry an earlier load of the page left: a discarded tab comes back on its old entry, counters restarted. */
const LOAD = Math.random().toString(36).slice(2);
let ids = 0;

/** An id for an overlay's history entry, its own among every load's. */
export function entryId(): string {
  return `${LOAD}.${++ids}`;
}

/** A Back `backOffEntry` took that has not landed yet. */
let landing = false;
let landed: ReturnType<typeof setTimeout> | undefined;

// Install before any view mounts. Window-targeted popstate listeners in Chromium run in registration order,
// even with capture, so installing this only when an overlay opens is too late for an existing Chat listener.
if (typeof window !== "undefined") window.addEventListener("popstate", (event) => {
  landing = false;
  clearTimeout(landed);
  for (const track of trackers) track(event);
}, true);

/** Only a return to an overlay's underlying entry belongs to that overlay. */
export function overlayTraversal(event: PopStateEvent): boolean {
  return traversals.has(event);
}

/** Call before pushing an overlay entry; close with true when Back already happened. */
export function trackOverlayHistory(under: unknown = history.state): (fromHistory: boolean) => void {
  const underlying = JSON.stringify(under);
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remove = () => {
    trackers.delete(onPop);
    clearTimeout(timer);
  };
  const onPop = (event: PopStateEvent) => {
    // The shared listener runs before the views, regardless of their mount order.
    if (JSON.stringify(event.state) === underlying) traversals.add(event);
    if (pending) remove();
  };
  trackers.add(onPop);
  return (fromHistory) => {
    if (fromHistory) return remove();
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(remove, 5000);
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * An overlay closed other than by Back whose entry is still the current one, its Back not taken yet. It waits a task, so
 * an overlay opening in the same task (a menu row's page) takes the entry over: a Back taken at once would land after
 * that overlay's push and close it, and leaving the entry would make the phone's next Back a dead step.
 */
let leaving: { state: unknown; under: unknown; untrack: (fromHistory: boolean) => void; take(): void } | null = null;

/** Takes a closed overlay's entry `state` back off, now or (`soon`) a task later unless an overlay takes it over first. */
export function backOffEntry(state: unknown, under: unknown, untrack: (fromHistory: boolean) => void, soon: boolean): void {
  const back = () => {
    if (leaving !== mine) return;
    leaving = null;
    // Something else moved history meanwhile: going back now would take its entry, not this one.
    if (!same(history.state, state)) return untrack(true);
    untrack(false);
    landing = true;
    clearTimeout(landed);
    landed = setTimeout(() => (landing = false), 400);
    history.back();
  };
  const mine = { state, under, untrack, take: back };
  leaving = mine;
  if (soon) setTimeout(back);
  else back();
}

/**
 * Pushes an overlay's entry, or replaces the entry an overlay just closed left (`backOffEntry`), so one Back still
 * leaves it to the screen under both. Returns its tracker's close; when the push throws, nothing is tracked.
 */
export function pushOverlayEntry(state: unknown): (fromHistory: boolean) => void {
  const left = leaving && same(history.state, leaving.state) ? leaving : null;
  if (left) leaving = null;
  const untrack = trackOverlayHistory(left ? left.under : history.state);
  try {
    if (left) history.replaceState(state, "");
    else history.pushState(state, "");
  } catch (error) {
    untrack(true);
    if (left) {
      left.untrack(false);
      history.back();
    }
    throw error;
  }
  left?.untrack(true);
  return untrack;
}

/**
 * Runs `next` once a Back `backOffEntry` took has landed (at once when none is in flight), so it cannot undo where `next`
 * goes. One still waiting its task is taken now and waited for too.
 */
export function afterOverlayBack(next: () => void): void {
  leaving?.take();
  if (!landing) return next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    window.removeEventListener("popstate", run);
    clearTimeout(timer);
    next();
  };
  window.addEventListener("popstate", run);
  timer = setTimeout(run, 400);
}
