import { DOWN_AFTER_FAILS, type Health } from "../../shared/ops.js";
import type { HealthCheck } from "../config.js";

// The server checks each RIVET_HEALTH_URLS entry itself: a plain GET with no
// credentials, no redirects followed and the body thrown away.

export const PROBE_TIMEOUT_MS = 8_000;
const CONCURRENCY = 6;

export interface ProbeResult {
  app: string;
  ok: boolean;
  status: number | null;
  ms: number | null;
}

export async function probe(entry: HealthCheck, fetchFn: typeof fetch, clock: () => number = Date.now): Promise<ProbeResult> {
  const started = clock();
  try {
    const response = await fetchFn(entry.url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "rivet-agents-health" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    return { app: entry.name, ok: response.status >= 200 && response.status < 300, status: response.status, ms: clock() - started };
  } catch {
    return { app: entry.name, ok: false, status: null, ms: null };
  }
}

export async function probeAll(entries: readonly HealthCheck[], fetchFn: typeof fetch): Promise<Map<string, ProbeResult>> {
  const results = new Map<string, ProbeResult>();
  const queue = [...entries];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        results.set(entry.name, await probe(entry, fetchFn));
      }
    }),
  );
  return results;
}

export const NO_CHECK: Health = { state: "no-check", status: null, ms: null, checkedAt: null, since: null, fails: 0 };
export const UNKNOWN: Health = { state: "unknown", status: null, ms: null, checkedAt: null, since: null, fails: 0 };

/** One failed check keeps the last state; DOWN_AFTER_FAILS in a row make it down, one success makes it up. */
export function nextHealth(previous: Health | undefined, result: ProbeResult, at: Date): Health {
  const before = previous ?? UNKNOWN;
  const fails = result.ok ? 0 : before.fails + 1;
  const state = result.ok ? "up" : fails >= DOWN_AFTER_FAILS ? "down" : before.state === "no-check" ? "unknown" : before.state;
  return {
    state,
    status: result.status,
    ms: result.ms,
    checkedAt: at.toISOString(),
    since: state === before.state && before.since ? before.since : at.toISOString(),
    fails,
  };
}
