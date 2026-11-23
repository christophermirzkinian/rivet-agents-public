import { z } from "zod";

import { DECISION } from "./answers.js";
import { ID_PATTERN, needSchema, type MediaRef, type Need } from "./board.js";
import { CLIENT_ID_PATTERN } from "./command.js";
import { defaultPick, EFFORT_LABELS, effortOnModel, jobOf, modelLabel, type Effort, type ModelJob, type ModelPick } from "./models.js";

// The "3 designs" button (Settings › Behaviours): from a card or a screen, the owner asks for 3 pictured design options. The
// server opens an ask and sends the monitor chat one line in his name; the chat it briefs posts one choice card to his
// board, which the card checker judges as it does every card.

export const THREE_DESIGNS_ID = "work.three-designs";
/** The model knob's value that follows Settings › Who does what › App look. */
export const DESIGNS_FOLLOW = "app-look";

const APP_LOOK: ModelJob = jobOf("app-look")!;

export const designsSchema = z.object({ on: z.boolean(), model: z.enum([DESIGNS_FOLLOW, ...APP_LOOK.models] as [string, ...string[]]) }).strict();
export type Designs = z.infer<typeof designsSchema>;
export const DEFAULT_DESIGNS: Designs = { on: true, model: DESIGNS_FOLLOW };

/** The model choices the row offers: App look's own, then each model App look may run on. */
export const DESIGNS_MODEL_CHOICES: readonly { value: string; label: string }[] = [
  { value: DESIGNS_FOLLOW, label: "App look's model" },
  ...APP_LOOK.models.map((model) => ({ value: model, label: modelLabel(model) })),
];

/**
 * The screens a screen's button may name: Main (the home screen; its own key, so the public export's word swap cannot meet
 * MORE_PAGES' "home"), Cards and Chat, then web/src/state.ts MORE_PAGES, which shared cannot import.
 */
export const DESIGN_SCREENS = ["main", "cards", "chat", "usage", "pipeline", "mind", "machines", "home", "media", "connectors", "settings", "what-you-used", "play"] as const;
export type DesignScreen = (typeof DESIGN_SCREENS)[number];

export const DESIGN_SCREEN_NAMES: Record<DesignScreen, string> = {
  main: "Main",
  cards: "Cards",
  chat: "Chat",
  usage: "Usage",
  pipeline: "Pipeline",
  mind: "Mind",
  machines: "Machines",
  home: "Home Automation",
  media: "Media",
  connectors: "Connectors",
  settings: "Settings",
  "what-you-used": "What you used",
  play: "Figures",
};

export const designsRequestSchema = z
  .object({ clientId: z.string().regex(CLIENT_ID_PATTERN), card: z.string().regex(ID_PATTERN).optional(), screen: z.enum(DESIGN_SCREENS).optional() })
  .strict()
  .superRefine((request, ctx) => {
    if ((request.card === undefined) === (request.screen === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "name a card or a screen, not both" });
  });
export type DesignsRequest = z.infer<typeof designsRequestSchema>;

export interface DesignsJob {
  kind: "designs";
  from: { card: string } | { screen: DesignScreen };
  model: string;
  effort: Effort;
  /** True when the model is App look's, false when the row names one. */
  followsAppLook: boolean;
  /** The ask it opened, a-N. */
  ask: string;
}

/** The model and effort the designs chat runs on: App look's pick as the Mac reported it (its default without one), or the row's model at that effort where it takes it. */
export function designsPick(knobs: Designs, appLook: ModelPick | null): ModelPick {
  const look = appLook ?? defaultPick(APP_LOOK);
  if (knobs.model === DESIGNS_FOLLOW) return look;
  return { model: knobs.model, effort: effortOnModel(APP_LOOK, knobs.model, look.effort) };
}

/** Null while the row is off. */
export function designsJob(request: DesignsRequest, knobs: Designs, appLook: ModelPick | null, ask: string): DesignsJob | null {
  if (!knobs.on) return null;
  const from = request.card !== undefined ? { card: request.card } : { screen: request.screen! };
  return { kind: "designs", from, ...designsPick(knobs, appLook), followsAppLook: knobs.model === DESIGNS_FOLLOW, ask };
}

/** The ask's words, on the owner's ask list: the card's id or the screen's name, never a card's chat-written title. */
export function designsWords(from: DesignsJob["from"]): string {
  return "card" in from ? `3 designs for card ${from.card}` : `3 designs for the ${DESIGN_SCREEN_NAMES[from.screen]} screen`;
}

/** The line to the monitor chat, in the owner's name, built only from checked values. */
export function designsLine(job: DesignsJob): string {
  const replyTo = "card" in job.from ? ` --reply-to ${job.from.card}` : "";
  const source = job.followsAppLook ? "Who does what › App look" : "set in Settings › Behaviours › 3 designs";
  return (
    `${designsWords(job.from)} (ask ${job.ask}): brief a chat on ${modelLabel(job.model)}, ${EFFORT_LABELS[job.effort].toLowerCase()} effort (${source}) ` +
    `to make 3 options, each with one still 1600 px or less on its long side, then post one choice card to my board only: ` +
    `rivet card add <new id> --title "<title>" --ask-id ${job.ask}${replyTo} --option "<A>" --option "<B>" --option "<C>" --still a.png --still b.png --still c.png, ` +
    `its --ask one item per option, a heading and at most 3 bullets. Nothing to a group chat or anyone else.`
  );
}

export interface DesignOption {
  label: string;
  bullets: string[];
  still: MediaRef;
}

/** The choice card the line asks for: one item, option and still per design. */
export function designsCard({ id, askId, replyTo, title, options }: { id: string; askId: string; replyTo?: string; title: string; options: readonly DesignOption[] }): Need {
  return needSchema.parse({
    id,
    kind: DECISION,
    title,
    ask: options.map((option) => [option.label, ...option.bullets.map((bullet) => `- ${bullet}`)].join("\n")).join("\n\n"),
    askId,
    ...(replyTo ? { replyTo } : {}),
    options: options.map((option) => ({ label: option.label })),
    media: { kind: "stills", stills: options.map((option) => option.still) },
  });
}
