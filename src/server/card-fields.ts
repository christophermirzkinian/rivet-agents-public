import type { Need } from "../shared/board.js";

// @ts-expect-error the bridge is plain ESM without type declarations
import * as bridgeFields from "../../bridge/lib/card-fields.mjs";

// What a card the board token writes may hold: the sending CLI's own rule (bridge/lib/card-fields.mjs), run here too, as
// not every writer is that CLI.

export const cardFieldRefusals = bridgeFields.cardFieldRefusals as (card: unknown, options: { stored?: Need | undefined; titled?: boolean; clean?: <T>(row: T) => T }) => string[];
export const cardsFieldsLine = bridgeFields.cardsFieldsLine as (lines: string[]) => string;
export const cardFieldsLine = bridgeFields.cardFieldsLine as (id: unknown, refusals: string[]) => string;
