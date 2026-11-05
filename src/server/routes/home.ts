import { homeControlAckSchema, homeControlSchema, homeSnapshotSchema, HOME_MAX_BYTES, type HomeControlError, type HomeResponse } from "../../shared/home.js";
import { HttpError, json, readJson, requireBearer, requireSameOrigin } from "../httputil.js";
import { parseRedacted } from "../redact.js";
import { OpsStore } from "../ops/store.js";
import type { Router } from "./router.js";

// The Home page: the user's tiles and buttons as Home Assistant reports them. The bridge PUTs a snapshot a minute; the
// page reads the last one. A press goes on to the bridge one at a time as a button id, and the answer is { ok: true } or
// an error code. Which service a button calls is the bridge's to know.

const CONTROL_BODY_MAX = 256;
/** How long a button waits for the bridge to say how it went; the web gives up on a write at 30 s. */
export const CONTROL_WAIT_MS = 15_000;
const CONTROL_TRIES = 30;
const CONTROL_WINDOW_MS = 15 * 60_000;

type Outcome = { ok: true } | { ok: false; error: HomeControlError | "timeout" };

export function register(router: Router): void {
  const { config, store, bridge, requireSession, now } = router.deps;
  const home = new OpsStore(config.dataDir);
  const waiting = new Map<string, (outcome: Outcome) => void>();
  router.onClose(() => {
    for (const settle of waiting.values()) settle({ ok: false, error: "timeout" });
    home.close();
  });

  router.on("PUT", "/api/bridge/home", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(homeSnapshotSchema, await readJson(request, HOME_MAX_BYTES));
    if (!parsed.success) {
      json(response, 400, { error: "invalid home snapshot", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    bridge.seen();
    home.put("home", { snapshot: parsed.data, receivedAt: now().toISOString() }, now());
    json(response, 200, { ok: true });
  });

  router.on("GET", "/api/home", ({ request, response }) => {
    requireSession(request);
    const stored = home.get("home");
    const body: HomeResponse = { snapshot: stored?.snapshot ?? null, receivedAt: stored?.receivedAt ?? null };
    json(response, 200, body);
  });

  router.on("POST", "/api/home/control", async ({ request, response }) => {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    if (store.countHit("home-control", "owner", CONTROL_WINDOW_MS) > CONTROL_TRIES) throw new HttpError(429, "too_many_tries");
    const parsed = homeControlSchema.safeParse(await readJson(request, CONTROL_BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid_button");
    if (waiting.size > 0) throw new HttpError(409, "busy");
    // The bridge's answer needs a moment to land, so it is told to have finished 2 s before the wait ends.
    const id = bridge.sendHomeControl({ button: parsed.data.button, until: Date.now() + CONTROL_WAIT_MS - 2_000 });
    if (id === null) throw new HttpError(503, "bridge_offline");
    const outcome = await new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => settle({ ok: false, error: "timeout" }), CONTROL_WAIT_MS);
      const settle = (result: Outcome) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(result);
      };
      waiting.set(id, settle);
    });
    if (outcome.ok) json(response, 200, { ok: true });
    else json(response, outcome.error === "timeout" ? 504 : 502, { error: outcome.error });
  });

  router.on("POST", "/api/bridge/home/control-ack", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = homeControlAckSchema.safeParse(await readJson(request, 1024));
    if (!parsed.success) throw new HttpError(400, "invalid ack");
    bridge.seen();
    const settle = waiting.get(parsed.data.id);
    if (!settle) throw new HttpError(404, "no such request");
    settle(parsed.data.ok ? { ok: true } : { ok: false, error: parsed.data.error ?? "home_assistant" });
    json(response, 200, { ok: true });
  });
}
