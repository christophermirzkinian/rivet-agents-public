#!/usr/bin/env node
// `npm run setup`: makes the settings Rivet Agents needs and writes them to .env (mode 0600) in the repo.
//
//   node scripts/setup.mjs [--origin <url>] [--port <n>] [--repos <owner/name,...>] [--force] [--keychain] [--dir <path>]
//
// Generates the board, bridge and enrolment tokens (32 random bytes each, as hex) and a VAPID key pair for web push,
// then prints the one-time enrolment link that signs your phone in. An existing .env is kept as it is unless --force.
// --keychain also stores the bridge and board tokens in the macOS login Keychain (service rivet-agents, account the
// setting's name); without it nothing outside .env is written. --dir writes .env there instead of the repo.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { isMain } from "./is-main.mjs";

export const KEYCHAIN_SERVICE = "rivet-agents";
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: setup.mjs [--origin <url>] [--port <n>] [--repos <owner/name,...>] [--force] [--keychain] [--dir <path>]";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

class Usage extends Error {}

/** A plain-http loopback origin is the server itself; any other (https, through tailscale serve) is a proxy's. */
const isLocal = (url) => url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

export function parseArgs(argv) {
  /** @type {{ origin?: string, port?: string, repos: string, force: boolean, keychain: boolean, dir: string, originGiven?: boolean }} */
  const opts = { repos: "", force: false, keychain: false, dir: REPO_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) throw new Usage(`${arg} needs a value`);
      return argv[(i += 1)];
    };
    if (arg === "--origin") opts.origin = value();
    else if (arg === "--port") opts.port = value();
    else if (arg === "--repos") opts.repos = value();
    else if (arg === "--dir") opts.dir = path.resolve(value());
    else if (arg === "--force") opts.force = true;
    else if (arg === "--keychain") opts.keychain = true;
    else throw new Usage(`unknown option ${arg}`);
  }
  opts.originGiven = opts.origin !== undefined;
  opts.origin ??= "http://localhost:8130";
  let url;
  try {
    url = new URL(opts.origin);
  } catch {
    throw new Usage(`--origin ${opts.origin} is not a URL`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Usage("--origin is an http:// or https:// URL");
  // The port the server listens on: --port, else the one a localhost origin names (http://localhost:9000). An https
  // origin's port is the proxy's (tailscale serve), not the server's, so it names none.
  const local = isLocal(url);
  if (opts.port !== undefined) {
    if (!/^\d{1,5}$/.test(opts.port) || Number(opts.port) < 1 || Number(opts.port) > 65535) throw new Usage(`--port ${opts.port} is not a port number`);
    opts.port = String(Number(opts.port));
    // With no --origin the page is the server's own, on that port. A localhost origin is the server itself, so its
    // port must be the one the server listens on.
    if (!opts.originGiven) url = new URL(`http://localhost:${opts.port}`);
    else if (local && opts.port !== (url.port || "80")) throw new Usage(`--port ${opts.port} is not the port in --origin ${url.origin}`);
  } else if (opts.originGiven && local && url.port) opts.port = url.port;
  opts.origin = url.origin;
  const repos = opts.repos.split(",").map((r) => r.trim()).filter(Boolean);
  const bad = repos.find((r) => !REPO_RE.test(r));
  if (bad) throw new Usage(`--repos: ${bad} is not owner/name`);
  opts.repos = repos.join(",");
  return opts;
}

const token = () => randomBytes(32).toString("hex");

/** The settings a fresh install starts with. */
export function makeSettings({ origin, repos, port }) {
  const vapid = webpush.generateVAPIDKeys();
  return {
    RIVET_ORIGIN: origin,
    // A port other than 8130 reaches the server, and the bridge and CLI that talk to it.
    ...(port !== undefined && port !== "8130" ? { RIVET_PORT: port, RIVET_URL: `http://127.0.0.1:${port}` } : {}),
    RIVET_BOARD_TOKEN: token(),
    RIVET_BRIDGE_TOKEN: token(),
    RIVET_ENROLL_TOKEN: token(),
    RIVET_VAPID_PUBLIC_KEY: vapid.publicKey,
    RIVET_VAPID_PRIVATE_KEY: vapid.privateKey,
    RIVET_VAPID_SUBJECT: origin.startsWith("https:") ? origin : "mailto:you@example.com",
    RIVET_REPOS: repos,
  };
}

export function envText(settings) {
  return [
    "# Written by npm run setup. Keep it secret: anyone with these tokens can post to your board or sign in.",
    "# See .env.example for every setting.",
    ...Object.entries(settings).map(([name, value]) => `${name}=${value}`),
    "",
  ].join("\n");
}

/** Reads a .env file's NAME=value lines. */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export const enrollLink = (origin, enrollToken) => `${origin}/#code=${encodeURIComponent(enrollToken)}`;

/** Stores a token in the login Keychain, replacing any older value (-U). */
export function storeInKeychain(name, value, run = spawnSync) {
  const r = run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", name, "-w", value], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (r.error || r.status !== 0) throw new Error(`could not store ${name} in the Keychain (${(r.stderr || r.error?.message || "").trim()})`);
}

export function main(argv = process.argv.slice(2), { out = (line) => console.log(line), run = spawnSync } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    out(USAGE);
    out("Writes .env (mode 0600) with fresh tokens and web-push keys, and prints your one-time sign-in link.");
    return;
  }
  const opts = parseArgs(argv);
  const file = path.join(opts.dir, ".env");
  let settings;
  if (fs.existsSync(file) && !opts.force) {
    settings = parseEnv(fs.readFileSync(file, "utf8"));
    out(`Kept ${file} as it is (pass --force to make new tokens; your phone would need to sign in again).`);
    // An --origin or --port given now is not in the kept file: say what to set, rather than drop it unsaid.
    // --port alone moves a kept localhost origin with it, never a proxy's; only a port given or named by a localhost
    // --origin is compared.
    if (opts.originGiven || opts.port !== undefined) {
      const want = [];
      let keptLocal = false;
      try {
        keptLocal = isLocal(new URL(settings.RIVET_ORIGIN ?? ""));
      } catch {}
      if ((opts.originGiven || keptLocal) && settings.RIVET_ORIGIN !== opts.origin) want.push(`RIVET_ORIGIN=${opts.origin}`);
      const { port } = opts;
      if (port !== undefined && String(Number(settings.RIVET_PORT ?? "8130")) !== port) want.push(`RIVET_PORT=${port}`, `RIVET_URL=http://127.0.0.1:${port}`);
      if (want.length) out(`It keeps its own settings, not the ones given here: set ${want.join(", ")} in it (or run with --force), then npm run install-bridge again.`);
    }
  } else {
    settings = makeSettings(opts);
    fs.mkdirSync(opts.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, envText(settings), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    out(`Wrote ${file} (mode 0600).`);
  }
  if (opts.keychain) {
    for (const name of ["RIVET_BRIDGE_TOKEN", "RIVET_BOARD_TOKEN"]) {
      if (!settings[name]) throw new Error(`${file} has no ${name}; run with --force`);
      storeInKeychain(name, settings[name], run);
    }
    out(`Stored RIVET_BRIDGE_TOKEN and RIVET_BOARD_TOKEN in the Keychain (service ${KEYCHAIN_SERVICE}).`);
  }
  if (settings.RIVET_ORIGIN && settings.RIVET_ENROLL_TOKEN) {
    out("");
    out("Open this link on your phone once to sign in (it works one time):");
    out(`  ${enrollLink(settings.RIVET_ORIGIN, settings.RIVET_ENROLL_TOKEN)}`);
  }
  out("");
  out("Next: npm run install-bridge   (or deploy the server with fly.toml and run install-bridge --no-server)");
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Usage ? `setup: ${error.message}\n${USAGE}` : `setup: ${error.message}`);
    process.exitCode = error instanceof Usage ? 2 : 1;
  }
}
