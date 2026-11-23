import { z } from "zod";

// Settings › Behaviours › Card checker: every card a chat posts is checked against the card rules, each rule
// refusing the card (block) or letting it post with a warning (warn). The server's checker is server/card-check.ts.

export const CARD_CHECKER_ID = "work.card-checker";

const rule = z.enum(["block", "warn"]);

export const cardCheckerSchema = z
  .object({
    on: z.boolean(),
    shape: rule,
    options: rule,
    stills: rule,
    video: rule,
    links: rule,
    // Read from pixels by the bridge's media check, which only warns: the server cannot decode a picture.
    edge: z.literal("warn"),
  })
  .strict();
export type CardChecker = z.infer<typeof cardCheckerSchema>;

export const DEFAULT_CARD_CHECKER: CardChecker = { on: true, shape: "warn", options: "block", stills: "warn", video: "block", links: "block", edge: "warn" };
