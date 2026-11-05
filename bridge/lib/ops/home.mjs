import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SECURITY_BIN } from "../config.mjs";

// The Home page's reading: the tiles and buttons in the user's own ~/.rivet-agents/home.json, against Home Assistant at
// RIVET_HA_URL, once a minute through its REST API. The token comes from RIVET_HA_TOKEN or the login Keychain and never
// leaves the bridge; nor do entity ids or services. When Home Assistant does not answer, the snapshot says only that.

export const HA_TOKEN_SERVICE = "rivet-agents-home-assistant";
const HA_TIMEOUT_MS = 8_000;
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const SERVICE_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const TOKEN_RE = /^[\x21-\x7e]{20,1024}$/;
const FILE_MAX_BYTES = 64 * 1024;
const DATA_MAX_BYTES = 2 * 1024;
// The server's schema (src/shared/home.ts) refuses a whole snapshot past its bounds, so the file is cut to them here.
const TILES_MAX = 24;
const BUTTONS_MAX = 12;
const LABEL_MAX = 40;
const VALUE_MAX = 64;
const UNIT_MAX = 12;
/** Keys that would point a service call somewhere other than the button's own entity. */
const TARGET_KEYS = new Set(["entity_id", "device_id", "area_id", "floor_id", "label_id"]);
/** Home Assistant's own words for having no reading. */
const NO_READING = new Set(["unavailable", "unknown"]);

/** @typedef {{ label: string, entity_id: string, unit: string | null }} TileSetting */
/** @typedef {{ id: string, label: string, service: string, entity_id: string, data: Record<string, unknown> }} ButtonSetting */

/** Where the user's tiles and buttons live. */
export function homeFile() {
  return path.join(os.homedir(), ".rivet-agents", "home.json");
}

/**
 * Home Assistant's address from RIVET_HA_URL, with no trailing slash; null when unset or not a plain http(s) URL.
 * @param {string | undefined} [raw]
 */
export function haBaseUrl(raw = process.env.RIVET_HA_URL) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** @param {unknown} raw @param {number} max @returns {string | null} */
function words(raw, max) {
  if (typeof raw !== "string") return null;
  return raw.trim().slice(0, max).trim() || null;
}

/** @param {any} row @returns {TileSetting | null} */
function tileSetting(row) {
  const label = words(row?.label, LABEL_MAX);
  if (!label || typeof row.entity_id !== "string" || !ENTITY_RE.test(row.entity_id)) return null;
  if (row.unit !== undefined && !words(row.unit, UNIT_MAX)) return null;
  return { label, entity_id: row.entity_id, unit: words(row.unit, UNIT_MAX) };
}

/** @param {any} row @returns {ButtonSetting | null} */
function buttonSetting(row) {
  const label = words(row?.label, LABEL_MAX);
  if (!label || typeof row.service !== "string" || !SERVICE_RE.test(row.service)) return null;
  if (typeof row.entity_id !== "string" || !ENTITY_RE.test(row.entity_id)) return null;
  const data = row.data ?? {};
  if (typeof data !== "object" || Array.isArray(data)) return null;
  if (Object.keys(data).some((key) => TARGET_KEYS.has(key)) || JSON.stringify(data).length > DATA_MAX_BYTES) return null;
  // From the whole row, so a page still showing a button the file has since changed presses nothing.
  const id = createHash("sha256").update(JSON.stringify([label, row.service, row.entity_id, data])).digest("hex").slice(0, 16);
  return { id, label, service: row.service, entity_id: row.entity_id, data };
}

/**
 * The user's home.json, read fresh each time so an edit needs no restart. No file is empty lists; a row that does not
 * fit is left out and counted.
 * @param {string} [file]
 * @returns {Promise<{ tiles: TileSetting[], buttons: ButtonSetting[], skipped: number }>}
 */
export async function readHomeSettings(file = homeFile()) {
  /** @type {any} */
  let raw;
  try {
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > FILE_MAX_BYTES) return { tiles: [], buttons: [], skipped: 1 };
    raw = JSON.parse(text);
  } catch (err) {
    return { tiles: [], buttons: [], skipped: /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT" ? 0 : 1 };
  }
  const tileRows = Array.isArray(raw?.tiles) ? raw.tiles : [];
  const buttonRows = Array.isArray(raw?.buttons) ? raw.buttons : [];
  const tiles = tileRows.map(tileSetting).filter(Boolean).slice(0, TILES_MAX);
  /** @type {Map<string, ButtonSetting>} */
  const buttons = new Map();
  for (const one of buttonRows.map(buttonSetting)) if (one && !buttons.has(one.id) && buttons.size < BUTTONS_MAX) buttons.set(one.id, one);
  return { tiles, buttons: [...buttons.values()], skipped: tileRows.length + buttonRows.length - tiles.length - buttons.size };
}

/**
 * Home Assistant's token: RIVET_HA_TOKEN, else the login Keychain; null when neither has one.
 * @param {import("../config.mjs").Exec} exec
 * @param {number} [timeout] ms
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function readHaToken(exec, timeout = 10_000, env = process.env) {
  const own = env.RIVET_HA_TOKEN?.trim();
  if (own) return TOKEN_RE.test(own) ? own : null;
  try {
    const out = await exec(SECURITY_BIN, ["find-generic-password", "-s", HA_TOKEN_SERVICE, "-w"], { timeout, maxBuffer: 64 * 1024 });
    const token = out.stdout.replace(/\r?\n$/, "");
    return TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * A JSON answer from Home Assistant. A 401 reads the token again and tries once more.
 * @param {{ fetch: typeof fetch, exec: import("../config.mjs").Exec, haUrl: string }} deps
 * @param {{ token: string | null }} cache
 * @param {string} path
 * @param {{ method?: string, body?: unknown, timeoutMs?: number }} [init]
 */
export async function haJson(deps, cache, path, init = {}) {
  cache.token ??= await readHaToken(deps.exec);
  // One deadline for the call, a 401's token read and second try included.
  const ms = init.timeoutMs ?? HA_TIMEOUT_MS;
  const until = Date.now() + ms;
  const signal = AbortSignal.timeout(ms);
  for (let attempt = 0; ; attempt++) {
    if (!cache.token) throw new Error("no home assistant token");
    const res = await deps.fetch(`${deps.haUrl}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${cache.token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal,
    });
    if (res.status === 401 && attempt === 0) {
      await res.body?.cancel().catch(() => {});
      cache.token = await readHaToken(deps.exec, Math.max(1, Math.min(5_000, until - Date.now())));
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`home assistant http ${res.status}`);
    }
    return res.json();
  }
}

/**
 * One tile's words from Home Assistant's state row; a missing entity or no reading is a null value.
 * @param {TileSetting} tile
 * @param {any} state
 */
function tileReading(tile, state) {
  const value = words(state?.state, VALUE_MAX);
  return { label: tile.label, value: value && !NO_READING.has(value) ? value : null, unit: tile.unit ?? words(state?.attributes?.unit_of_measurement, UNIT_MAX) };
}

/**
 * One pass: the snapshot to PUT, or `{ at, haReachable: false }` when Home Assistant did not answer.
 * @param {{ fetch: typeof fetch, exec: import("../config.mjs").Exec, haUrl: string, file?: string, now?: () => Date, cache: { token: string | null }, timeoutMs?: number, log?: (event: string, fields?: Record<string, unknown>) => void }} deps
 */
export async function collectHome(deps) {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const settings = await readHomeSettings(deps.file);
  if (settings.skipped > 0) deps.log?.("home-file-rows-skipped", { skipped: settings.skipped });
  /** @type {Map<string, any>} */
  let states;
  try {
    const list = await haJson(deps, deps.cache, "/api/states", { timeoutMs: deps.timeoutMs });
    if (!Array.isArray(list)) throw new Error("home assistant states is not a list");
    states = new Map(list.filter((one) => typeof one?.entity_id === "string").map((one) => [one.entity_id, one]));
  } catch {
    return { at, haReachable: /** @type {const} */ (false) };
  }
  return {
    at,
    haReachable: /** @type {const} */ (true),
    tiles: settings.tiles.map((tile) => tileReading(tile, states.get(tile.entity_id))),
    buttons: settings.buttons.map(({ id, label }) => ({ id, label })),
  };
}
