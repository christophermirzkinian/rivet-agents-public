import { z } from "zod";

import type { PushSettingsResponse } from "../../shared/quiet.js";
import { HttpError, json, readJson, requireSameOrigin } from "../httputil.js";
import { inQuiet } from "../quiet.js";
import type { Router } from "./router.js";

const SMALL_BODY_MAX = 64 * 1024;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const quietSettingsSchema = z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }).strict();

export function register(router: Router): void {
  const { config, requireSession, push, quiet, now } = router.deps;

  const settings = (): PushSettingsResponse => {
    const { enabled, start, end } = quiet.settings();
    return { enabled, start, end, held: quiet.heldCount(), quietNow: inQuiet({ enabled, start, end }, now()) };
  };

  router.on("GET", "/api/settings/push", ({ request, response }) => {
    requireSession(request);
    json(response, 200, settings());
  });

  router.on("PUT", "/api/settings/push", async ({ request, response }) => {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    const parsed = quietSettingsSchema.safeParse(await readJson(request, SMALL_BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid push settings");
    quiet.putSettings(parsed.data);
    // Turning quiet hours off, or moving them, lets what they held go now.
    await push.flushHeld().catch(() => null);
    json(response, 200, settings());
  });
}
