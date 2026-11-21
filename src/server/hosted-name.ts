// A hosted machine's runtime points RIVET_AGENT_FILE at its agent's own file, where setup saves the name its customer
// chose and its host the app's name (`app`); the server's words follow it as the app's do. The owner's own machine sets
// none, and nothing here runs.
import fs from "node:fs";

import { checkedAgentName, checkedAppName, nameHostedAgent, UNNAMED_AGENT } from "../shared/names.js";

const MAX_BYTES = 4096;
const WATCH_MS = 2_000;

let followers = 0;
/** An agent file is followed: a hosted machine, whatever its app is named. */
export const onHostedMachine = (): boolean => followers > 0;

export interface HostedAgent {
  name: string | null;
  app: string | null;
}

/**
 * The file's name (null for none yet) and app (null for the build's own), or null when it can't be read as a whole:
 * only a regular file of at most MAX_BYTES, never through a link.
 */
export function readHostedAgent(file: string): HostedAgent | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_BYTES) return null;
    const saved: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!saved || typeof saved !== "object") return null;
    const { name, app } = saved as Record<string, unknown>;
    return { name: checkedAgentName(name), app: checkedAppName(app) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Names the agent and the app from the file now and at each change to it; returns the stop. Until the file is first
 * read the agent is UNNAMED_AGENT; a later read that fails (a torn write, a passing error) keeps the last good names.
 * The app is the file's, else the host's RIVET_APP_NAME, else the build's own: the runtime leaves the file unwritten
 * while it can't tell whether setup is done.
 */
export function followHostedName(file = process.env.RIVET_AGENT_FILE): () => void {
  if (!file) return () => {};
  const hostApp = checkedAppName(process.env.RIVET_APP_NAME);
  const read = () => {
    const agent = readHostedAgent(file);
    if (agent) nameHostedAgent(agent.name ?? UNNAMED_AGENT, agent.app ?? hostApp);
  };
  followers += 1;
  nameHostedAgent(UNNAMED_AGENT, hostApp);
  read();
  fs.watchFile(file, { interval: WATCH_MS, persistent: false }, read);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    followers -= 1;
    fs.unwatchFile(file, read);
  };
}
