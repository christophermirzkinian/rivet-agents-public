import { iso, parseJson } from "./common.mjs";

// Read-only Fly status for the Ops tab: `flyctl status --json` and
// `flyctl releases --json` per app, reduced to status fields. Machine config,
// secrets, IPs and release authors never leave the Mac.

export const FLY_TIMEOUT_MS = 30_000;
export const APP_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MAX_APPS = 100;
export const MAX_RELEASES = 30;
const RELEASE_DAYS = 14;
const WORD_RE = /^[a-z_]{0,30}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
export const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,199}$/i;

/** The Fly apps in RIVET_FLY_APPS, those a Fly name can be. @param {NodeJS.ProcessEnv} [env] */
export function flyApps(env = process.env) {
  return (env.RIVET_FLY_APPS ?? "").split(",").map((app) => app.trim()).filter((app) => APP_RE.test(app)).slice(0, MAX_APPS);
}

/** @param {unknown} value */
function word(value) {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  return WORD_RE.test(s) ? s : "";
}

/** @param {string} stdout `flyctl status --json -a <app>` output */
export function parseFlyStatus(stdout) {
  const doc = parseJson(stdout, "flyctl");
  const machines = Array.isArray(doc?.Machines) ? doc.Machines : [];
  let started = 0;
  let passing = 0;
  let checks = 0;
  let updatedAt = null;
  let sha = null;
  let version = Number.isInteger(doc?.Version) && doc.Version >= 0 ? doc.Version : null;
  for (const m of machines) {
    if (m?.state === "started") started += 1;
    for (const c of Array.isArray(m?.checks) ? m.checks : []) {
      checks += 1;
      if (c?.status === "passing") passing += 1;
    }
    const at = iso(m?.updated_at);
    if (at && (!updatedAt || at > updatedAt)) {
      updatedAt = at;
      const labels = m?.image_ref?.labels;
      const label = labels?.RIVET_DEPLOY_SHA ?? labels?.GH_SHA;
      sha = typeof label === "string" && SHA_RE.test(label) ? label.slice(0, 12) : sha;
      const release = Number(m?.config?.metadata?.fly_release_version);
      if (version === null && Number.isInteger(release) && release >= 0) version = release;
    }
  }
  return {
    status: word(doc?.Status),
    version,
    sha,
    machines: { started, total: machines.length },
    checks: { passing, total: checks },
    updatedAt,
  };
}

/**
 * The last 14 days of releases, newest first: version, status, time and image. When the oldest of them is not complete,
 * the last complete release before it follows, however old, so each release has an image to be compared with.
 * @param {string} stdout `flyctl releases --json -a <app>` output
 * @param {Date} now
 */
export function parseReleases(stdout, now) {
  const list = parseJson(stdout, "flyctl");
  const cutoff = now.getTime() - RELEASE_DAYS * 24 * 3600_000;
  const all = [];
  for (const r of Array.isArray(list) ? list : []) {
    const at = iso(r?.CreatedAt);
    if (!at || !Number.isInteger(r?.Version) || r.Version < 0) continue;
    const status = word(r?.Status);
    if (!status) continue;
    // The image tells a code deploy from a secrets or config release, which keeps the image it had.
    const image = typeof r?.ImageRef === "string" && IMAGE_RE.test(r.ImageRef) ? r.ImageRef : null;
    const sha = releaseSha(image);
    all.push({ version: r.Version, status, at, ...(image ? { image } : {}), ...(sha ? { sha } : {}) });
  }
  all.sort((a, b) => b.version - a.version);
  const out = all.filter((release) => Date.parse(release.at) >= cutoff).slice(0, MAX_RELEASES);
  // Each release sent is compared with the last complete one before it, the oldest sent too, however long ago that was.
  const below = () => {
    const oldest = out.at(-1);
    return oldest ? all.find((release) => release.status === "complete" && release.version < oldest.version) : undefined;
  };
  if (below()) {
    if (out.length === MAX_RELEASES) out.pop();
    const baseline = below();
    if (baseline) out.push(baseline);
  }
  return out;
}

/**
 * Each app's last good data and whether its latest fetch worked.
 * @returns {Map<string, { value: any, at: string | null, ok: boolean }>}
 */
export function emptyFlyCache() {
  return new Map();
}

/**
 * One pass. A failed fetch (flyctl logged out, say) keeps that app's last good data and names
 * the app in `source.failed`, so the server shows it as unreachable rather than as no failed deploys.
 * @param {{ exec: import("../config.mjs").Exec, flyBin: string, apps: string[], now?: () => Date,
 *   cache?: ReturnType<typeof emptyFlyCache>, log?: (event: string, fields?: Record<string, unknown>) => void }} deps
 */
export async function collectFly(deps) {
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const log = deps.log ?? (() => {});
  const cache = deps.cache ?? emptyFlyCache();
  const fly = (/** @type {string[]} */ args) => deps.exec(deps.flyBin, args, { timeout: FLY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout);
  const names = deps.apps.filter((name) => APP_RE.test(name)).slice(0, MAX_APPS);
  for (const app of names) {
    try {
      const status = parseFlyStatus(await fly(["status", "--json", "-a", app]));
      const releases = parseReleases(await fly(["releases", "--json", "-a", app]), now);
      cache.set(app, { value: { app, ...status, releases }, at, ok: true });
    } catch (err) {
      const previous = cache.get(app);
      cache.set(app, { value: previous?.value ?? null, at: previous?.at ?? null, ok: false });
      log("ops-fly-app-failed", { app, error: err instanceof Error ? err.message : "error" });
    }
  }
  const failed = names.filter((app) => cache.get(app)?.ok === false);
  const times = failed.map((app) => cache.get(app)?.at ?? null);
  return {
    at,
    apps: names.map((app) => cache.get(app)?.value).filter(Boolean),
    source: { failed, at: times.includes(null) ? null : (times.sort()[0] ?? null) },
  };
}

/** Only source-bearing tags; Fly deployment IDs and digest hex are not git commits. */
export function releaseSha(image) {
  if (typeof image !== "string" || image.includes("@")) return null;
  const colon = image.lastIndexOf(":");
  if (colon <= image.lastIndexOf("/")) return null;
  const tag = image.slice(colon + 1);
  return /^direct-([0-9a-f]{12})-[a-z0-9]+$/.exec(tag)?.[1]
    ?? /^(?:sha-)?([0-9a-f]{40})$/.exec(tag)?.[1] ?? null;
}
