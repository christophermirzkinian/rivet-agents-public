import { collectHome, haBaseUrl, haJson, homeFile, readHaToken, readHomeSettings } from "../ops/home.mjs";

// The Home page's buttons. The page sends a button id; the only calls made are the service and entity that id names in
// the user's home.json, read at the press. An id not in the file is refused without touching Home Assistant, and so is a
// press on an entity Home Assistant reports unavailable: the page says at once that nothing changed.

/** @typedef {import("./index.mjs").ActionContext} ActionContext */
/** @typedef {import("./index.mjs").ActionResult} ActionResult */
/** @typedef {"not_set_up" | "unknown_button" | "home_assistant" | "offline"} Failure */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRESS_BUDGET_MS = 12_000;
const ACK_TIMEOUT_MS = 10_000;
/** A press with less than this left of the server's wait is not run: its answer would land after the page gave up. */
const MIN_LEFT_MS = 2_000;
const SNAPSHOT_MAX_MS = 3_000;

/**
 * @param {{ haUrl?: string, file?: string }} [options]
 */
export function createHomeFamily(options = {}) {
  /**
   * @param {ActionContext["deps"]} deps
   * @param {string} haUrl
   * @param {import("../ops/home.mjs").ButtonSetting} button
   * @param {number} until when the answer must be on its way (epoch ms)
   * @returns {Promise<{ ok: true } | { ok: false, error: Failure }>}
   */
  async function press(deps, haUrl, button, until) {
    const left = () => Math.max(1, until - Date.now());
    const cache = { token: await readHaToken(deps.exec, Math.min(5_000, left())) };
    if (!cache.token) return { ok: false, error: "not_set_up" };
    const [domain, service] = button.service.split(".");
    const ha = { fetch: deps.fetch, exec: deps.exec, haUrl };
    // "unavailable" is Home Assistant's word for a device it can't reach. "unknown" is not: a scene or a script that has
    // never run reads that. A state read that fails stops nothing; the press itself says whether Home Assistant is there.
    const now = await haJson(ha, cache, `/api/states/${button.entity_id}`, { timeoutMs: Math.min(4_000, left()) }).catch(() => null);
    if (now?.state === "unavailable") return { ok: false, error: "offline" };
    try {
      const body = { ...button.data, entity_id: button.entity_id };
      await haJson(ha, cache, `/api/services/${domain}/${service}`, { method: "POST", body, timeoutMs: Math.min(8_000, left()) });
      return { ok: true };
    } catch {
      return { ok: false, error: "home_assistant" };
    }
  }

  /**
   * A fresh reading to the server, so the page's refresh after a press shows what the button did.
   * @param {ActionContext["deps"]} deps
   * @param {string} haUrl
   * @param {string} file
   */
  async function pushSnapshot(deps, haUrl, file) {
    const cache = { token: await readHaToken(deps.exec, SNAPSHOT_MAX_MS) };
    const snapshot = await collectHome({ fetch: deps.fetch, exec: deps.exec, haUrl, file, cache, timeoutMs: SNAPSHOT_MAX_MS });
    const res = await deps.fetch(`${deps.origin}/api/bridge/home`, {
      method: "PUT",
      headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
      body: JSON.stringify(snapshot),
      redirect: "error",
      signal: AbortSignal.timeout(SNAPSHOT_MAX_MS),
    });
    await res.body?.cancel().catch(() => {});
  }

  return {
    family: "home",
    events: Object.freeze(["home-control"]),
    /**
     * @param {string} _event
     * @param {unknown} raw
     * @param {ActionContext} ctx
     * @returns {Promise<ActionResult>}
     */
    async handle(_event, raw, ctx) {
      const { origin, token, log } = ctx.deps;
      const r = /** @type {any} */ (raw && typeof raw === "object" ? raw : {});
      const id = typeof r.id === "string" && UUID_RE.test(r.id) ? r.id : null;
      if (!id) {
        log("drop", { id: "?", reason: "bad-home-control" });
        return "dropped";
      }
      // The server says when its wait ends; time spent behind other work in the bridge's queue counts against it.
      const own = Date.now() + PRESS_BUDGET_MS;
      const until = Number.isSafeInteger(r.until) ? Math.min(own, r.until) : own;
      if (until - Date.now() < MIN_LEFT_MS) {
        log("drop", { id, reason: "home-control-late" });
        return "dropped";
      }
      const haUrl = options.haUrl ?? haBaseUrl();
      const file = options.file ?? homeFile();
      const button = haUrl ? (await readHomeSettings(file)).buttons.find((one) => one.id === r.button) : undefined;
      /** @type {{ ok: true } | { ok: false, error: Failure }} */
      const result = !haUrl ? { ok: false, error: "not_set_up" } : !button ? { ok: false, error: "unknown_button" } : await press(ctx.deps, haUrl, button, until);
      log(result.ok ? "home-control-done" : "home-control-failed", result.ok ? { id } : { id, error: result.error });
      // The race bounds the whole of it, a slow Keychain read for the token included.
      if (result.ok && haUrl && until - Date.now() > SNAPSHOT_MAX_MS + MIN_LEFT_MS) {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        await Promise.race([pushSnapshot(ctx.deps, haUrl, file).catch(() => {}), new Promise((resolve) => (timer = setTimeout(resolve, SNAPSHOT_MAX_MS)))]);
        clearTimeout(timer);
      }
      try {
        const res = await ctx.deps.fetch(`${origin}/api/bridge/home/control-ack`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ id, ...result }),
          redirect: "error",
          signal: AbortSignal.timeout(ACK_TIMEOUT_MS),
        });
        await res.body?.cancel().catch(() => {});
        if (!res.ok) throw new Error(`home ack http ${res.status}`);
      } catch (err) {
        log("ack-failed", { id, error: err instanceof Error ? err.message.slice(0, 120) : "error" });
      }
      return result.ok ? "delivered" : "dropped";
    },
  };
}

export const home = createHomeFamily();
