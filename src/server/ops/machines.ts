import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { MACHINE_HISTORY_MS, MACHINE_METRICS, type MachineHistoryResponse, type MachineReadings, type MachineSeries } from "../../shared/machines.js";
import { worstVolume, type MacSnapshot } from "../../shared/ops.js";

// See store.ts: node:sqlite goes through createRequire under vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

type DatabaseSync = InstanceType<typeof DatabaseSync>;

/** 12 machines × 8 days × one reading every 5 minutes is 27,648 rows: the cap sits just above. */
export const MAX_MACHINE_ROWS = 30_000;
/** One row per machine per minute at most: a burst of reports (a hand run beside the timer) adds nothing. */
const MIN_GAP_MS = 60_000;

/** Each metric's column; `cpu` is the load per core. */
const COLUMNS = { cpuUsedPct: "cpu_used", loadPct: "cpu", memUsedPct: "mem", diskFreePct: "disk", batteryPct: "battery" } as const;
const NAMES = MACHINE_METRICS.map((metric) => COLUMNS[metric]);

// Its own connection to the app database, like OpsStore.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS machine_readings (
  machine TEXT NOT NULL,
  at      INTEGER NOT NULL,
  name    TEXT NOT NULL,
  cpu     REAL,
  mem     REAL,
  disk    REAL,
  battery REAL,
  cpu_used REAL,
  PRIMARY KEY (machine, at)
);
CREATE INDEX IF NOT EXISTS machine_readings_at ON machine_readings (at);
`;

type Row = { machine: string; at: number; name: string } & Record<(typeof COLUMNS)[keyof typeof COLUMNS], number | null>;

/** The Mac's readings over the last MACHINE_HISTORY_MS, for the Machines trend: bounded by age and by row count. */
/** A Mac snapshot as one machine's row: its load per core, memory in use and the fullest volume's free space. */
export function macMachine(mac: MacSnapshot): { id: string; name: string; readings: MachineReadings } {
  const worst = worstVolume(mac.volumes);
  return {
    id: mac.name,
    name: mac.name,
    readings: {
      ...(mac.load.cpus > 0 ? { loadPct: Math.round((mac.load.one / mac.load.cpus) * 100) } : {}),
      ...(mac.memory.pressure === "unknown" ? {} : { memUsedPct: 100 - mac.memory.freePct }),
      ...(worst && worst.totalBytes > 0 ? { diskFreePct: Math.round((worst.freeBytes / worst.totalBytes) * 100) } : {}),
    },
  };
}

export class MachineHistory {
  private readonly db: DatabaseSync;
  private readonly maxRows: number;

  /** `maxRows` is only lowered by tests, so the cap is checked without thousands of writes. */
  constructor(dataDir: string, { maxRows = MAX_MACHINE_ROWS }: { maxRows?: number } = {}) {
    this.maxRows = maxRows;
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "rivet.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** One row per machine that sent a number, at server time; old rows and those past the cap go in the same step. */
  record(machines: readonly { id: string; name: string; readings?: MachineReadings }[], at: Date): number {
    const t = at.getTime();
    const recent = this.db.prepare("SELECT 1 FROM machine_readings WHERE machine = ? AND at > ? AND at <= ?");
    const insert = this.db.prepare(
      `INSERT INTO machine_readings (machine, at, name, ${NAMES.join(", ")}) VALUES (?, ?, ?, ${NAMES.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let added = 0;
      for (const machine of machines) {
        const values = MACHINE_METRICS.map((metric) => {
          const value = machine.readings?.[metric];
          return typeof value === "number" && Number.isFinite(value) ? value : null;
        });
        if (values.every((value) => value === null) || recent.get(machine.id, t - MIN_GAP_MS, t)) continue;
        added += Number(insert.run(machine.id, t, machine.name, ...values).changes);
      }
      this.db.prepare("DELETE FROM machine_readings WHERE at < ?").run(t - MACHINE_HISTORY_MS);
      const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM machine_readings").get() as { n: number };
      if (n > this.maxRows) this.db.prepare("DELETE FROM machine_readings WHERE rowid IN (SELECT rowid FROM machine_readings ORDER BY at ASC LIMIT ?)").run(n - this.maxRows);
      this.db.exec("COMMIT");
      return added;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM machine_readings").get() as { n: number }).n;
  }

  /**
   * Each machine's readings after `since` (epoch seconds) within the kept window, oldest first. A metric a machine never
   * sent in them is left out; values are whole percentages.
   */
  read(now: Date, since = 0): MachineHistoryResponse {
    const from = Math.max(now.getTime() - MACHINE_HISTORY_MS, (Math.floor(since) + 1) * 1000);
    const rows = this.db.prepare("SELECT * FROM machine_readings WHERE at >= ? ORDER BY machine, at").all(from) as Row[];
    const machines = new Map<string, MachineSeries>();
    for (const row of rows) {
      let series = machines.get(row.machine);
      if (!series) {
        series = { id: row.machine, name: row.name, t: [], values: {} };
        machines.set(row.machine, series);
      }
      series.name = row.name;
      const i = series.t.push(Math.floor(row.at / 1000)) - 1;
      for (const metric of MACHINE_METRICS) {
        const value = row[COLUMNS[metric]];
        if (value === null) continue;
        const column = (series.values[metric] ??= []);
        while (column.length < i) column.push(null);
        column.push(Math.round(value));
      }
    }
    for (const series of machines.values())
      for (const column of Object.values(series.values)) while (column.length < series.t.length) column.push(null);
    return { now: now.toISOString(), machines: [...machines.values()] };
  }
}
