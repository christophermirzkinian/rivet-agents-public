import type { Worker } from "../../src/shared/workers.js";
import { IN_HAND, NEEDS_YOU } from "../../src/shared/words.js";

// The crew's words the Feed and the worker sheet share: a state's word and how long ago.

export const STATE_WORDS: Record<Worker["state"], string> = { working: IN_HAND.building, waiting: NEEDS_YOU, blocked: "Blocked", idle: "Idle" };

