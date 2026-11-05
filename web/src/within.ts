/**
 * `step`, or a rejection with `message` once `ms` pass without it settling: a browser wait that is not a fetch (a
 * lazy import, a decode, a push step) has no deadline of its own, and a stalled one would leave its view stuck.
 * The step itself is not stopped.
 */
export function within<T>(step: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([step, late]).finally(() => clearTimeout(timer));
}

/**
 * A share sheet waits on the user, so one still open this long is no failure; its control just stops waiting on it,
 * and a late answer is still handled.
 */
export const SHARE_WAIT_MS = 60_000;
