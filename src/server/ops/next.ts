import { buildNext, type NextRow } from "../../shared/ops-next.js";
import type { Schedule } from "../../shared/schedules.js";

/** The Plan page's Next rows: the schedules' next runs. */
export function nextRows(now: Date, schedules: readonly Schedule[] | null): NextRow[] {
  return buildNext({ now, schedules });
}
