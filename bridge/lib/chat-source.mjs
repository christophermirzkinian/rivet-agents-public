import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The chat runner (scripts/rivet-chat.mjs), the one way the bridge reaches a chat: every list, read, send, Pause and new
// chat shells out to its CLI, so a hung tmux never holds the bridge's loop. A chat is named by its name.

/** The runner's CLI in the same app folder as this file: the install copy or the checkout it runs from. */
export const CHAT_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "rivet-chat.mjs");

const LIST_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 35_000;
const START_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 10_000;
/** Screen rows read to tell whether a typed line was submitted. */
const SUBMIT_READ_LINES = 40;
const SUBMIT_POLLS = 6;
const SUBMIT_POLL_MS = 500;
/** The poll after which a line still in the input gets one more Enter: a long line can swallow the first. */
const SUBMIT_ENTER_AT = 2;
/** Escape must arrive alone: text straight after it would read as an Alt key. */
const INTERRUPT_SETTLE_MS = 400;
const RULE_RE = /^\s*─{10,}\s*$/;
const PROMPT_RE = /^\s*[│|]?\s*[❯>]/;
/** How much of a line's end the input is searched for: enough not to match by chance, short enough to fit a wrap. */
const NEEDLE_CHARS = 24;

/**
 * A runner row as a Terminal. `pending`: a chat that is not finished but has no running agent now. Nothing can type to
 * it, and it has not closed.
 * @param {unknown} raw one row of `rivet-chat ls --json`
 * @returns {import("./terminals.mjs").Terminal | null}
 */
export function runnerTerminal(raw) {
  const chat = /** @type {any} */ (raw);
  if (!chat || typeof chat.name !== "string" || !chat.name || typeof chat.provider !== "string") return null;
  const alive = chat.state === "alive";
  if (chat.status === "finished" && !alive) return null;
  const startedAt = Date.parse(chat.started);
  return {
    handle: chat.name,
    name: chat.name,
    ...(typeof chat.worktree === "string" ? { worktreePath: chat.worktree } : {}),
    ...(typeof chat.repo === "string" && chat.repo ? { repo: chat.repo } : {}),
    connected: alive,
    writable: alive,
    agentIdentity: chat.provider,
    pending: !alive,
    ...(typeof chat.lastOutputAt === "number" ? { lastOutputAt: chat.lastOutputAt } : {}),
    ...(typeof chat.title === "string" ? { title: chat.title } : {}),
    ...(typeof chat.branch === "string" ? { branch: `refs/heads/${chat.branch}` } : {}),
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
  };
}

/**
 * Whether a typed line left Claude's input box, read from the screen. The box is the rows between the last two full
 * width rules. "unknown" when there is no such box, so a screen not understood is never counted as submitted.
 * @param {string[]} screen @param {string} line
 * @returns {"submitted" | "in-input" | "unknown"}
 */
export function submitState(screen, line) {
  const rules = screen.flatMap((row, at) => (RULE_RE.test(row) ? [at] : []));
  if (rules.length < 2) return "unknown";
  const rows = screen.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]);
  // Two rules in the output are not the box, and a prompt below the last rule is a box still being drawn.
  if (!PROMPT_RE.test(rows[0] ?? "") || screen.slice(rules[rules.length - 1] + 1).some((row) => PROMPT_RE.test(row))) return "unknown";
  const box = rows.join("").replace(/\s+/g, "");
  if (box.includes("[Pastedtext")) return "in-input";
  const needle = line.replace(/\s+/g, "").slice(-NEEDLE_CHARS);
  return needle && box.includes(needle) ? "in-input" : "submitted";
}

/**
 * The runner, through its CLI.
 * @param {{ exec: import("./config.mjs").Exec, nodeBin?: string, cli?: string, cwd?: string, env?: Record<string, string>,
 *   sleep?: (ms: number) => Promise<void> }} deps cwd: where a new chat runs, the home folder unless given
 */
export function createChatRunner(deps) {
  const node = deps.nodeBin ?? process.execPath;
  const cli = deps.cli ?? CHAT_CLI;
  const cwd = deps.cwd ?? os.homedir();
  const sleep = deps.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const run = (/** @type {string[]} */ args, /** @type {number} */ timeout, /** @type {string | undefined} */ input) =>
    deps.exec(node, [cli, ...args], { timeout, maxBuffer: 16 * 1024 * 1024, ...(deps.env ? { env: deps.env } : {}), ...(input === undefined ? {} : { input }) });
  const rows = async () => {
    const { stdout } = await run(["ls", "--json"], LIST_TIMEOUT_MS);
    const doc = JSON.parse(stdout);
    if (!Array.isArray(doc)) throw new Error("unexpected rivet-chat ls output");
    return doc;
  };

  /** @param {string} name @param {number} lines @returns {Promise<string[]>} */
  async function read(name, lines) {
    const { stdout } = await run(["read", name, "--lines", String(lines)], READ_TIMEOUT_MS);
    return stdout.replace(/\n$/, "").split("\n");
  }

  return {
    /** No registry is an empty list; a registry the runner cannot read is an error. */
    async list() {
      return (await rows()).flatMap((row) => runnerTerminal(row) ?? []);
    },
    read,
    /** @param {string} name */
    async interrupt(name) {
      await run(["interrupt", name], READ_TIMEOUT_MS);
      await sleep(INTERRUPT_SETTLE_MS);
    },
    /**
     * Starts a new chat named `name` with `prompt` as its first message, on stdin.
     * @param {string} name @param {string} prompt
     */
    async start(name, prompt) {
      await run(["new", name, "--cwd", cwd, "--prompt-file", "-"], START_TIMEOUT_MS, prompt);
    },
    /**
     * Types one line and presses Enter: taken input counts as delivered and is never typed again. Only a screen that
     * moved and shows the line gone from the input confirms it: one unchanged since before the line went in is an agent
     * that has not read it. Only Claude's screen has the box this reads, so any other chat is typed to and left
     * unconfirmed.
     * @param {string} name @param {string} line
     * @returns {Promise<{ confirmed: boolean, stages: string[] }>}
     */
    async send(name, line) {
      const claude = await rows()
        .then((doc) => doc.some((/** @type {any} */ chat) => chat?.name === name && chat.provider === "claude"))
        .catch(() => false);
      const before = claude ? await read(name, SUBMIT_READ_LINES).then((screen) => screen.join("\n")).catch(() => null) : null;
      // The line goes on stdin, never in the runner's arguments.
      await run(["send", name, "--text-file", "-"], SEND_TIMEOUT_MS, line);
      if (!claude) return { confirmed: false, stages: ["accepted"] };
      for (let poll = 0; poll < SUBMIT_POLLS; poll += 1) {
        await sleep(SUBMIT_POLL_MS);
        let screen;
        try {
          screen = await read(name, SUBMIT_READ_LINES);
        } catch {
          continue;
        }
        const state = submitState(screen, line);
        if (state === "submitted" && before !== null && screen.join("\n") !== before) return { confirmed: true, stages: ["accepted", "submitted"] };
        if (state === "in-input" && poll === SUBMIT_ENTER_AT) await run(["send", name, "--text", ""], READ_TIMEOUT_MS).catch(() => {});
      }
      return { confirmed: false, stages: ["accepted"] };
    },
  };
}

/** @typedef {ReturnType<typeof createChatRunner>} ChatRunner */
