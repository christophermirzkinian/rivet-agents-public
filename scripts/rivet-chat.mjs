#!/usr/bin/env node
// `node scripts/rivet-chat.mjs <command>`: your own Claude Code and Codex chats, in tmux on the rivet-chat socket.
// Every command runs through the chat runner (scripts/chat-runner.mjs), which owns the registry
// (~/.rivet-agents/chats/registry.json) and every tmux call.
//
//   new <name> [--cwd <dir>] [--prompt <text> | --prompt-file <f|->] [--provider claude|codex]
//                                plain `claude` (or `codex`) on your own login, in an existing directory (default the
//                                current one), with RIVET_CLAUDE_ARGS / RIVET_CODEX_ARGS before the prompt
//   ls [--json]                  every chat and whether its session is alive, dead (its agent exited) or gone
//   send <chat> --text <t> | --text-file <f|->
//                                types the text, then Enter
//   interrupt <chat>             Escape
//   read <chat> [--lines N]      the last N lines of its screen
//   close <chat>                 ends its own process group and session; it is finished
//   open <chat>                  attaches this terminal
//
// A file named - is stdin: text from another program goes there, never in this command's arguments.
// A <chat> is its name, its session or its directory. Exit codes: 0 done, 1 refused or failed, 2 usage.
import fs from "node:fs";
import * as runner from "./chat-runner.mjs";
import { isMain } from "./is-main.mjs";

const USAGE = "usage: rivet-chat.mjs new|ls|send|interrupt|read|close|open (see the header)";
const HELP = [
  "usage: rivet-chat.mjs <command>",
  "  new <name> [--cwd <dir>] [--prompt <text> | --prompt-file <f|->] [--provider claude|codex]",
  "  ls [--json]",
  "  send <chat> --text <t> | --text-file <f|->",
  "  interrupt <chat>",
  "  read <chat> [--lines N]",
  "  close <chat>",
  "  open <chat>",
].join("\n");
const VALUE_FLAGS = new Set(["--cwd", "--prompt", "--prompt-file", "--provider", "--text", "--text-file", "--lines"]);
const BOOL_FLAGS = new Set(["--json"]);

export class Usage extends Error {}

/** A file's text, stdin for "-". */
const readText = (file) => fs.readFileSync(file === "-" ? 0 : file, "utf8");

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      if (argv[i + 1] === undefined) throw new Usage(`${arg} needs a value`);
      flags[arg.slice(2)] = argv[(i += 1)];
    } else if (BOOL_FLAGS.has(arg)) {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith("--")) {
      throw new Usage(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

const one = (args, what) => {
  if (args.length !== 1) throw new Usage(`${what} takes one <chat>`);
  return args[0];
};

export async function main(argv = process.argv.slice(2), { ctx = runner.context(), cwd = process.cwd(), out = (line) => console.log(line) } = {}) {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    out(HELP);
    return 0;
  }
  const { command, args, flags } = parseArgs(argv);
  switch (command) {
    case "new": {
      const name = one(args, "new");
      if (flags.prompt !== undefined && flags["prompt-file"] !== undefined) throw new Usage("give --prompt or --prompt-file, not both");
      const provider = flags.provider ?? "claude";
      if (!runner.PROVIDERS.has(provider)) throw new Usage(`--provider is claude or codex, not ${provider}`);
      const entry = runner.create(ctx, {
        name,
        cwd: flags.cwd ?? cwd,
        provider,
        prompt: flags["prompt-file"] !== undefined ? readText(flags["prompt-file"]) : (flags.prompt ?? null),
      });
      out(`${entry.session} running in ${entry.worktree}`);
      return 0;
    }
    case "ls": {
      const chats = runner.ps(ctx);
      if (flags.json) out(JSON.stringify(chats, null, 2));
      else for (const c of chats) out([c.session, c.status, c.state, c.provider, c.worktree].join("\t"));
      return 0;
    }
    case "send":
      if ((flags.text === undefined) === (flags["text-file"] === undefined)) throw new Usage("send needs --text or --text-file, not both");
      runner.send(ctx, one(args, "send"), flags.text ?? readText(flags["text-file"]));
      return 0;
    case "interrupt":
      runner.interrupt(ctx, one(args, "interrupt"));
      return 0;
    case "read":
      out(runner.read(ctx, one(args, "read"), { lines: flags.lines ?? 60 }));
      return 0;
    case "close": {
      const entry = runner.close(ctx, one(args, "close"));
      out(`${entry.session} finished${entry.sessionLeft ? "; its tmux session was left running (it has no pane of the chat's)" : ""}`);
      return 0;
    }
    case "open":
      return runner.attach(ctx, one(args, "open"));
    default:
      throw new Usage(command ? `unknown command ${command}` : "no command");
  }
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Usage ? `rivet-chat: ${error.message}\n${USAGE}` : error.message);
    process.exitCode = error instanceof Usage ? 2 : 1;
  }
}
