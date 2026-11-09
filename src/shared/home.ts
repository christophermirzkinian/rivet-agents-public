import { z } from "zod";

// The Home page: the readings and buttons the user listed in ~/.rivet-agents/home.json, as Home Assistant reports them.
// The bridge sends one small snapshot a minute; when it cannot reach Home Assistant it sends only that. Entity ids,
// services and the token stay on the bridge: the server and the page know a tile's words and a button's id and label.

/** The bridge's PUT answers 413 past this. */
export const HOME_MAX_BYTES = 16 * 1024;
export const HOME_TILES_MAX = 24;
export const HOME_BUTTONS_MAX = 12;
export const HOME_BUTTON_ID_RE = /^[0-9a-f]{16}$/;
/** Room over what the bridge sends (bridge/lib/ops/home.mjs), so a redacted copy, which can run longer, still fits. */
const LABEL_MAX = 64;
const VALUE_MAX = 96;
const UNIT_MAX = 32;

const iso = z.string().datetime();
const buttonId = z.string().regex(HOME_BUTTON_ID_RE);

const tileSchema = z
  .object({ label: z.string().min(1).max(LABEL_MAX), value: z.string().min(1).max(VALUE_MAX).nullable(), unit: z.string().min(1).max(UNIT_MAX).nullable() })
  .strict();
const buttonSchema = z.object({ id: buttonId, label: z.string().min(1).max(LABEL_MAX) }).strict();

const reachedSchema = z
  .object({ at: iso, haReachable: z.literal(true), tiles: z.array(tileSchema).max(HOME_TILES_MAX), buttons: z.array(buttonSchema).max(HOME_BUTTONS_MAX) })
  .strict();
const unreachedSchema = z.object({ at: iso, haReachable: z.literal(false) }).strict();

export const homeSnapshotSchema = z.discriminatedUnion("haReachable", [reachedSchema, unreachedSchema]);

export type HomeSnapshot = z.infer<typeof homeSnapshotSchema>;
export type HomeReading = z.infer<typeof reachedSchema>;
export type HomeTile = z.infer<typeof tileSchema>;
export type HomeButton = z.infer<typeof buttonSchema>;

export interface HomeResponse {
  snapshot: HomeSnapshot | null;
  receivedAt: string | null;
}

export const homeControlSchema = z.object({ button: buttonId }).strict();

/** Why the bridge did not press a button. */
export const HOME_CONTROL_ERRORS = ["not_set_up", "unknown_button", "home_assistant", "offline"] as const;
export type HomeControlError = (typeof HOME_CONTROL_ERRORS)[number];

export const homeControlAckSchema = z
  .object({ id: z.string().uuid(), ok: z.boolean(), error: z.enum(HOME_CONTROL_ERRORS).optional() })
  .strict();
