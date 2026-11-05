// The Machines trend: this Mac's numbers, kept on the server for a week, one line on the Machines page.

/** One machine's numbers, as percentages; a machine leaves out what it cannot read. */
export interface MachineReadings {
  /** The CPU in use, all cores together: 100 is every core busy, never past it. */
  cpuUsedPct?: number;
  /** The 5-minute load as a share of its cores: past 100 when work queues. */
  loadPct?: number;
  memUsedPct?: number;
  diskFreePct?: number;
  batteryPct?: number;
}

export const MACHINE_METRICS = ["cpuUsedPct", "loadPct", "memUsedPct", "diskFreePct", "batteryPct"] as const;
export type MachineMetric = (typeof MACHINE_METRICS)[number];

/** How long the server keeps the readings: the chart's longest range, 7 days, and a day over. */
export const MACHINE_HISTORY_MS = 8 * 24 * 3600_000;

/** One machine's readings, oldest first: `t` in epoch seconds, each metric it has one value (or null) per `t`. */
export interface MachineSeries {
  id: string;
  name: string;
  t: number[];
  values: Partial<Record<MachineMetric, (number | null)[]>>;
}

export interface MachineHistoryResponse {
  /** Server time, so the chart's "now" is the server's. */
  now: string;
  machines: MachineSeries[];
}
