import assert from "node:assert/strict";

const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

/** The growth a read may show at 8 times the size: a linear read costs 8 times as much, a quadratic one 64. */
const GROWTH = 32;
/** The most CPU the larger read may cost at all, so a read that is slow at every size still fails. */
const BACKSTOP_MS = 5000;

/**
 * Asserts that a read stays linear: at 8 times the input's size it costs well under the 64 times a quadratic pass or
 * a backtracking regex costs. A fixed limit on one size failed on a loaded runner with no regression,
 * so only the growth is judged, with a loose limit on the larger read behind it. The two sizes are a quarter of and
 * twice the size the caller names, so a redactor budget that cuts a much longer line short does not hide the growth.
 * Each size's best of three runs is read in CPU time, not wall-clock time, and a reading over either limit is
 * taken again, up to three times.
 * @param {(input: T) => unknown} read @param {(k: number) => T} input the input at k times its size
 * @param {string} label @template T
 */
export function assertLinear(read, input, label) {
  const sizes = [input(1 / 4), input(2)];  let growth = Infinity;
  let slowest = Infinity;
  const linear = () => {
    const best = [Infinity, Infinity];
    for (let run = 0; run < 3; run += 1) {
      for (const [i, size] of sizes.entries()) {
        const started = cpuMs();
        read(size);
        best[i] = Math.min(best[i], cpuMs() - started);
      }
    }
    growth = best[1] / best[0];
    slowest = best[1];
    return growth < GROWTH && slowest < BACKSTOP_MS;
  };
  assert.ok([0, 1, 2].some(linear), `${label} costs ${growth.toFixed(1)} times as much at 8 times the size (${Math.round(slowest)}ms)`);
}
