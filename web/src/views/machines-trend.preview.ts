import type { MachineHistoryResponse, MachineMetric } from "../../../src/shared/machines.js";

const now = new Date();

// The Machines trend: a week of readings every 5 minutes, the same on every load, the second machine silent since it went
// down and for three hours two days ago. ?trend=empty shows the page before the first numbers.
export function fakeHistory(): MachineHistoryResponse {
  if (new URLSearchParams(location.search).get("trend") === "empty") return { now: now.toISOString(), machines: [] };
  const step = 5 * 60_000;
  const end = Math.floor(now.getTime() / step) * step;
  const week = 7 * 24 * 3600_000;
  const hours = (t: number) => (end - t) / 3600_000;
  let seed = 7;
  const noise = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  const wave = (t: number, period: number, phase = 0) => Math.sin((t / 3600_000 / period) * 2 * Math.PI + phase);
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const series = (id: string, name: string, read: (t: number) => Partial<Record<MachineMetric, number>> | null) => {
    const t: number[] = [];
    const values: Partial<Record<MachineMetric, (number | null)[]>> = {};
    for (let at = end - week; at <= end; at += step) {
      const v = read(at);
      if (!v) continue;
      const i = t.push(at / 1000) - 1;
      for (const [metric, value] of Object.entries(v) as [MachineMetric, number][]) {
        const column = (values[metric] ??= []);
        while (column.length < i) column.push(null);
        column.push(Math.round(value));
      }
    }
    for (const column of Object.values(values)) while (column.length < t.length) column.push(null);
    return { id, name, t, values };
  };
  return {
    now: now.toISOString(),
    machines: [
      series("this-mac", "This Mac", (t) => ({ cpuUsedPct: clamp(30 + 18 * wave(t, 24) + 8 * wave(t, 3, 1) + 6 * noise()), loadPct: 48 + 22 * wave(t, 24) + 9 * wave(t, 3, 1) + 10 * noise(), memUsedPct: clamp(72 + 8 * wave(t, 12) + 3 * noise()), diskFreePct: 69 + (3 * hours(t)) / 168 })),
      series("laptop", "Laptop", (t) =>
        hours(t) < 0.25 || (hours(t) > 50 && hours(t) < 53)
          ? null
          : { cpuUsedPct: clamp(20 + 85 * Math.max(0, wave(t, 6, 2)) + 5 * noise()), loadPct: 30 + 1150 * Math.max(0, wave(t, 6, 2)) + 30 * noise(), memUsedPct: clamp(55 + 10 * wave(t, 8) + 3 * noise()), diskFreePct: 40 + hours(t) / 168, batteryPct: hours(t) > 30 && hours(t) < 34 ? 100 - (34 - hours(t)) * 12 : 100 },
      ),
    ],
  };
}
