import { z } from "zod";

import { isRealTime } from "./board.js";

// The Costs page: one row per service in A$ a month, actual or estimate, and when it was last checked. Rivet writes the
// rows with the board token (`rivet cost set`).

export const COST_KINDS = ["actual", "estimate"] as const;
export type CostKind = (typeof COST_KINDS)[number];
export const COST_SERVICE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_COST_NAME = 60;
export const MAX_COST_NOTE = 200;
/** PUT answers 507 once the store holds this many. */
export const MAX_COSTS = 40;

/** A$ for one US dollar and one euro, the rates Rivet converts its rows with. */
export const COST_FX = { checked: "2026-10-07", audPerUsd: 1.433, audPerEur: 1.613 } as const;

const LINE = /^[^\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]+$/;
const time = z.string().datetime({ offset: true }).refine(isRealTime, "a time with an offset within ±14:00");
const line = (max: number, what: string) =>
  z.string().min(1).max(max).regex(LINE, `${what} is one line`).refine((text) => text.trim() !== "", `${what} must not be blank`);

/** PUT /api/costs/:service: the whole row; `checkedAt` defaults to now. */
export const costPutSchema = z
  .object({
    name: line(MAX_COST_NAME, "a name"),
    aud: z.number().finite().min(0).max(1_000_000),
    kind: z.enum(COST_KINDS),
    note: line(MAX_COST_NOTE, "a note").optional(),
    group: line(MAX_COST_NAME, "a group").optional(),
    checkedAt: time.optional(),
  })
  .strict();
export type CostPut = z.infer<typeof costPutSchema>;

export interface CostRow {
  service: string;
  name: string;
  /** A$ a month. */
  aud: number;
  kind: CostKind;
  note?: string;
  /** Rows with the same group show as one card, its total and the rows under it ("AI Specialised Services"). */
  group?: string;
  checkedAt: string;
  /** Worked out by the app from the bridge's readings; an actual or newer row Rivet sets replaces it. */
  auto?: boolean;
}

export interface CostsResponse {
  rows: CostRow[];
  monthAud: number;
  yearAud: number;
  fx: typeof COST_FX;
}

/** Rivet's rows, the dearest first. */
export function costsView(stored: readonly CostRow[]): CostsResponse {
  const sorted = [...stored].sort((a, b) => b.aud - a.aud || a.name.localeCompare(b.name));
  const monthAud = sorted.reduce((sum, row) => sum + row.aud, 0);
  return { rows: sorted, monthAud: whole(monthAud), yearAud: whole(monthAud * 12), fx: COST_FX };
}

const whole = (aud: number) => Math.round(aud);
