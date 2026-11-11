#!/usr/bin/env node
import { makeExec, readToken, serverOrigin } from "../bridge/lib/config.mjs";
import { sanitizeLine } from "../bridge/lib/templates.mjs";

const USAGE = `Attach Rivet's short note to the briefing on show in the Rivet app.

  node briefing-note.mjs --text "<one line, up to 280 characters>"

The note lands on the latest morning or evening briefing and shows under it as
plain text. Up to 5 notes per briefing; a sixth drops the oldest.

Token: RIVET_BRIDGE_TOKEN in the environment, or in the Keychain under service rivet-agents.
Server: RIVET_URL (default https://<your-app>.fly.dev; http only for localhost).
`;

export const NOTE_MAX = 280;

/** @param {string} msg @param {number} [code] */
function fail(msg, code = 1) {
  process.stderr.write(`briefing-note: ${msg}\n`);
  return code;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ text?: string, help?: boolean }} */
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--text") {
      if (o.text !== undefined) throw new Error("--text given twice");
      o.text = argv[++i];
      if (o.text === undefined) throw new Error("--text needs the note");
    } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** One line of plain text, or an error message. @param {string} text */
export function checkNote(text) {
  const line = sanitizeLine(text, 10_000);
  if (!line) return { error: "the note is empty" };
  // The next flag swallowed as the note (say's `--text --stdin` sent the owner "--stdin", 11 Nov) is never his to read.
  if (line.startsWith("--") || line === "-h") return { error: `--text got "${sanitizeLine(line, 40)}" as the note, a flag; give --text the note itself. Nothing was sent` };
  if (line.length > NOTE_MAX) return { error: `the note is ${line.length} characters; the limit is ${NOTE_MAX}` };
  return { line };
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    return fail(`${/** @type {Error} */ (err).message}\n\n${USAGE}`, 2);
  }
  if (o.help || o.text === undefined) {
    process.stdout.write(USAGE);
    return o.help ? 0 : 2;
  }
  const note = checkNote(o.text);
  if (note.error !== undefined) return fail(note.error, 2);

  const origin = serverOrigin(process.env.RIVET_URL || undefined);
  const token = await readToken(makeExec(), "RIVET_BRIDGE_TOKEN");
  const res = await fetch(`${origin}/api/bridge/briefing-note`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: note.line }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return fail("no briefing yet");
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return fail(`http ${res.status}`);
  }
  const doc = await res.json().catch(() => null);
  process.stdout.write(`noted on ${typeof doc?.briefing === "string" ? sanitizeLine(doc.briefing, 60) : "the latest briefing"}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.exitCode = fail(err instanceof Error ? err.message : "error");
    },
  );
}
