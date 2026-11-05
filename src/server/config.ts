import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CHAT_PATTERN } from "../shared/board.js";
import { setDefaultRepo } from "../shared/board.js";
import { defaultRepo, repoAllowlist, setKnownRepos } from "../shared/repos.js";
import { setTimeZone } from "../shared/when.js";

export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface Config {
  port: number;
  dataDir: string;
  origin: string;
  rpId: string;
  production: boolean;
  /** SHA-256 digests only; a null digest disables the token's routes. */
  boardTokenDigest: Buffer | null;
  bridgeTokenDigest: Buffer | null;
  enrollTokenDigest: Buffer | null;
  /** Null (push off) unless all three RIVET_VAPID_* values are set. */
  vapid: VapidConfig | null;
  webRoot: string;
  /** The chat a message with no Reply goes to; empty when each such message starts a new chat. */
  monitorChat: string;
  /** RIVET_MERGE=on: a merge-ready card's yes merges its PR. Off, the yes is a plain approve. */
  merge: boolean;
  /** RIVET_HEALTH_URLS: the apps Ops checks, in the order given. Empty with nothing set. */
  healthChecks: HealthCheck[];
}

export interface HealthCheck {
  name: string;
  url: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function digestOf(value: string | undefined): Buffer | null {
  const trimmed = value?.trim();
  return trimmed ? sha256(trimmed) : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  if (production && !env.RIVET_ORIGIN) {
    throw new Error("RIVET_ORIGIN is required when NODE_ENV=production");
  }
  const origin = new URL(env.RIVET_ORIGIN ?? "http://localhost:5230").origin;
  const port = Number(env.RIVET_PORT ?? 8130);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("RIVET_PORT must be an integer port number");
  }
  const tokens = {
    RIVET_BOARD_TOKEN: digestOf(env.RIVET_BOARD_TOKEN),
    RIVET_BRIDGE_TOKEN: digestOf(env.RIVET_BRIDGE_TOKEN),
    RIVET_ENROLL_TOKEN: digestOf(env.RIVET_ENROLL_TOKEN),
  };
  // Each token is one role. A shared value would let, say, the board token enrol a passkey or act as the bridge.
  const set = Object.entries(tokens).filter((entry): entry is [string, Buffer] => entry[1] !== null);
  for (const [i, [name, digest]] of set.entries()) {
    const twin = set.slice(i + 1).find(([, other]) => other.equals(digest));
    if (twin) throw new Error(`${name} and ${twin[0]} must be different tokens`);
  }
  const monitorChat = env.RIVET_MONITOR_CHAT?.trim() ?? "";
  if (monitorChat && !CHAT_PATTERN.test(monitorChat)) throw new Error("RIVET_MONITOR_CHAT is not a valid chat name");
  try {
    setTimeZone(env.RIVET_TIME_ZONE);
  } catch {
    throw new Error(`RIVET_TIME_ZONE is not a time zone this runtime knows: ${env.RIVET_TIME_ZONE}`);
  }
  setDefaultRepo(defaultRepo(env));
  setKnownRepos(repoAllowlist(env));
  return {
    port,
    dataDir: resolve(env.RIVET_DATA_DIR?.trim() || join(homedir(), ".rivet-agents", "data")),
    origin,
    rpId: new URL(origin).hostname,
    production,
    boardTokenDigest: tokens.RIVET_BOARD_TOKEN,
    bridgeTokenDigest: tokens.RIVET_BRIDGE_TOKEN,
    enrollTokenDigest: tokens.RIVET_ENROLL_TOKEN,
    vapid: vapidOf(env),
    webRoot: resolve(PACKAGE_ROOT, "dist/web"),
    monitorChat,
    merge: env.RIVET_MERGE === "on",
    healthChecks: healthChecksOf(env.RIVET_HEALTH_URLS),
  };
}

/** `name=url` pairs split by commas. A pair that is not one, or not http(s), stops the server: a typo would read as "no checks". */
export function healthChecksOf(value: string | undefined): HealthCheck[] {
  const pairs = (value ?? "").split(",").map((pair) => pair.trim()).filter(Boolean);
  return pairs.map((pair) => {
    const at = pair.indexOf("=");
    const name = pair.slice(0, Math.max(at, 0)).trim();
    const url = pair.slice(at + 1).trim();
    if (!name || !/^https?:\/\/\S+$/.test(url)) throw new Error(`RIVET_HEALTH_URLS has a bad entry: use name=https://example.com/health`);
    return { name, url };
  });
}

function vapidOf(env: NodeJS.ProcessEnv): VapidConfig | null {
  const publicKey = env.RIVET_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.RIVET_VAPID_PRIVATE_KEY?.trim();
  const subject = env.RIVET_VAPID_SUBJECT?.trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}
