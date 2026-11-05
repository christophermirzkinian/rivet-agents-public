const traversals = new WeakSet<PopStateEvent>();
const trackers = new Set<(event: PopStateEvent) => void>();

// Install before any view mounts. Window-targeted popstate listeners in Chromium run in registration order,
// even with capture, so installing this only when an overlay opens is too late for an existing Chat listener.
if (typeof window !== "undefined") window.addEventListener("popstate", (event) => {
  for (const track of trackers) track(event);
}, true);

/** Only a return to an overlay's underlying entry belongs to that overlay. */
export function overlayTraversal(event: PopStateEvent): boolean {
  return traversals.has(event);
}

/** Call before pushing an overlay entry; close with true when Back already happened. */
export function trackOverlayHistory(): (fromHistory: boolean) => void {
  const underlying = JSON.stringify(history.state);
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
