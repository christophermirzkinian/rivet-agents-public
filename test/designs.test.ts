import { describe, expect, it } from "vitest";

import { checkCards, type MediaSizeOf } from "../src/server/card-check.js";
import { BEHAVIOURS } from "../src/shared/behaviours.js";
import { DEFAULT_CARD_CHECKER } from "../src/shared/card-check.js";
import {
  DEFAULT_DESIGNS,
  DESIGN_SCREENS,
  designsCard,
  designsJob,
  designsLine,
  designsPick,
  designsRequestSchema,
  designsSchema,
  THREE_DESIGNS_ID,
  type DesignOption,
} from "../src/shared/designs.js";
import { defaultPick, jobOf } from "../src/shared/models.js";
import { MORE_PAGES } from "../web/src/state.js";

// The "3 designs" button: the request, the model it runs on, the line to the monitor chat, and the card it asks for.

const APP_LOOK = jobOf("app-look")!;
const sha = (n: number) => String(n).repeat(64).slice(0, 64);

describe("3 designs", () => {
  it("takes a card or a screen, exactly one, each checked", () => {
    const ok = (body: unknown) => designsRequestSchema.safeParse(body).success;
    expect(ok({ clientId: "client-0001", card: "pick-a-look" })).toBe(true);
    expect(ok({ clientId: "client-0001", screen: "settings" })).toBe(true);
    expect(ok({ clientId: "client-0001", card: "pick-a-look", screen: "settings" })).toBe(false);
    expect(ok({ clientId: "client-0001" })).toBe(false);
    expect(ok({ clientId: "client-0001", card: "../x/y" })).toBe(false);
    expect(ok({ clientId: "client-0001", card: "a b" })).toBe(false);
    expect(ok({ clientId: "client-0001", screen: "nowhere" })).toBe(false);
    expect(ok({ clientId: "short", card: "pick" })).toBe(false);
    expect(ok({ clientId: "client-0001", card: "pick", extra: 1 })).toBe(false);
  });

  it("names every screen the menu opens", () => {
    for (const page of MORE_PAGES) expect(DESIGN_SCREENS).toContain(page);
    expect(DESIGN_SCREENS).toEqual(expect.arrayContaining(["main", "cards", "chat"]));
    expect(new Set(DESIGN_SCREENS).size).toBe(DESIGN_SCREENS.length);
  });

  it("runs on App look's pick as reported, its default without one, or the row's model at an effort it takes", () => {
    const reported = { model: APP_LOOK.models[1]!, effort: "max" as const };
    expect(designsPick(DEFAULT_DESIGNS, reported)).toEqual(reported);
    expect(designsPick(DEFAULT_DESIGNS, null)).toEqual(defaultPick(APP_LOOK));
    const pinned = { on: true, model: APP_LOOK.models[0]! };
    expect(designsPick(pinned, reported)).toEqual({ model: APP_LOOK.models[0], effort: "max" });
    expect(designsPick(pinned, null)).toEqual({ model: APP_LOOK.models[0], effort: APP_LOOK.effort });
    // An effort the pinned model does not take falls back to the job's.
    expect(designsPick({ on: true, model: "claude-opus-5-5" }, { model: "claude-fable-5-2", effort: "nope" as "max" }).effort).toBe(APP_LOOK.effort);
    expect(designsSchema.safeParse({ on: true, model: "claude-haiku-5-5" }).success).toBe(false);
    expect(designsJob({ clientId: "client-0001", card: "c1" }, { ...DEFAULT_DESIGNS, on: false }, null, "a-1")).toBeNull();
  });

  it("tells the monitor which model, the ask, the card and the card's shape, for the board only and with no link", () => {
    const job = designsJob({ clientId: "client-0001", card: "pick-a-look" }, DEFAULT_DESIGNS, { model: "claude-opus-5-5", effort: "high" }, "a-12")!;
    const line = designsLine(job);
    expect(line).toContain("3 designs for card pick-a-look (ask a-12)");
    expect(line).toContain("Opus 5.5, high effort (Who does what › App look)");
    expect(line).toContain("--ask-id a-12 --reply-to pick-a-look");
    expect(line).toContain("1600");
    expect(line).toContain("board only");
    expect(line).toContain("Nothing to a group chat or anyone else.");
    expect(line).not.toMatch(/https?:/);
    expect(line.length).toBeLessThanOrEqual(600);

    const screen = designsLine(designsJob({ clientId: "client-0001", screen: "settings" }, { on: true, model: "claude-fable-5-2" }, null, "a-13")!);
    expect(screen).toContain("3 designs for the Settings screen (ask a-13)");
    expect(screen).toContain("Fable 5.2, high effort (set in Settings › Behaviours › 3 designs)");
    expect(screen).not.toContain("--reply-to");
  });

  it("is a Work row in Behaviours, on by default, its model picked beside its switch", () => {
    const row = BEHAVIOURS.find((one) => one.id === THREE_DESIGNS_ID)!;
    expect(row).toMatchObject({ group: "Work", scope: "all", control: "live", choices: { key: "model", switch: true } });
    expect(row.line).toBeTruthy();
    expect(row.knobs.safeParse(row.default).success).toBe(true);
    expect(row.chip?.(row.default)).toBe("App look's model");
    expect(row.chip?.({ on: true, model: "claude-opus-5-5" })).toBe("Opus 5.5");
    expect(row.choices!.options.map((option) => option.value)).toEqual(["app-look", ...APP_LOOK.models]);
  });

  const options = (stills: number): DesignOption[] =>
    ["Calm", "Bold", "Loud"].map((label, index) => ({ label, bullets: [`${label} colours`, "Big buttons"], still: { sha256: sha(index < stills ? index + 1 : 1), type: "image/png" } }));
  const sizes: MediaSizeOf = () => ({ width: 1600, height: 900 });

  it("asks for a card the card checker passes whole", () => {
    const card = designsCard({ id: "designs-a-12", askId: "a-12", replyTo: "pick-a-look", title: "3 designs for the board", options: options(3) });
    expect(card.options).toHaveLength(3);
    expect(card.media?.stills).toHaveLength(3);
    expect(checkCards({ cards: [card], sentCards: [card], storedCards: [], knobs: DEFAULT_CARD_CHECKER, mediaSize: sizes, videoSizes: [] })).toEqual({ refusals: [], warnings: [] });
  });

  it("is refused by the checker with a still missing", () => {
    const card = designsCard({ id: "designs-a-12", askId: "a-12", title: "3 designs for the board", options: options(3) });
    const short = { ...card, media: { kind: "stills" as const, stills: card.media!.stills!.slice(0, 2) } };
    const result = checkCards({ cards: [short], sentCards: [short], storedCards: [], knobs: DEFAULT_CARD_CHECKER, mediaSize: sizes, videoSizes: [] });
    expect(result.refusals).toEqual([expect.stringContaining("3 options but 2 stills")]);
  });
});
