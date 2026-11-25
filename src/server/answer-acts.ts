import type { Decision, Need, Reply } from "../shared/board.js";

// @ts-expect-error the bridge is plain ESM without type declarations
import { mayActByCode as bridgeMayAct } from "../../bridge/lib/answer-acts.mjs";
// @ts-expect-error the bridge is plain ESM without type declarations
import * as holds from "../../bridge/lib/card-holds.mjs";

/** Whether code may act on a stored answer: the bridge's own rule (bridge/lib/answer-acts.mjs). */
export const mayActByCode = bridgeMayAct as (reply: Pick<Reply, "at" | "item">) => boolean;

const isYes = holds.isYes as (reply: { decision: Decision; choice?: string }) => boolean;
const isVideoCard = holds.isVideoCard as (card: Need) => boolean;
const cardHoldPrs = holds.cardHoldPrs as (card: Need) => number[];

/** Whether that answer to the card releases a pull request's merge hold, by the bridge's own reading of both. */
export const releasesHold = (need: Need, decision: Decision, choice?: string): boolean =>
  isYes({ decision, choice }) && isVideoCard(need) && cardHoldPrs(need).length > 0;
