#!/usr/bin/env node
// Sends Rivet's mind: the Markdown in the folders the user names, as one graph, to PUT /api/bridge/mind. Every source
// is a setting with no default: RIVET_MIND_MEMORY_DIR (a flat folder of memory files, with an index file and topic-*
// hubs), RIVET_MIND_NOTES_DIR and RIVET_MIND_DECISIONS_DIR (folders of Markdown, read through their subfolders). None
// set is a valid empty graph. It reads only those folders. A graph the same as the last one sent goes again only after
// RESEND_MS, so the page's built time stays fresh.
//
//   node scripts/mind-export.mjs                  # build and send
//   node scripts/mind-export.mjs --out graph.json # build and write, send nothing
//   --memory <dir> --notes <dir> --decisions <dir> --state <dir> override the settings for one run

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { makeExec, readToken, serverOrigin } from "../bridge/lib/config.mjs";
import { redactKeepingLines } from "../bridge/lib/redact-cut.mjs";

export const BODY_MAX = 6000;
const LABEL_MAX = 120;
const DESC_MAX = 400;
const NODES_MAX = 5000;
const LINKS_MAX = 20_000;
/** Under the server's 3 MB, with room for the JSON a text grows by when it is escaped. */
const BYTES_MAX = 2_900_000;
const RESEND_MS = 60 * 60_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/;
const ID_MAX = 200;
const INDEX_RE = /^(memory|index)\.md$/i;
const TYPES = new Set(["feedback", "project", "reference", "user"]);

/** One line of words. @param {string} text */
const oneLine = (text) => text.replace(/\s+/g, " ").trim();

/**
 * Redacted, then cut at a line to `max` and ended with "…".
 * @param {string} text
 * @param {number} [max]
 */
export function clean(text, max = BODY_MAX) {
  const kept = redactKeepingLines(text).trim();
  if (kept.length <= max) return kept;
  const cut = kept.slice(0, max);
  const line = cut.lastIndexOf("\n");
  return `${(line > max / 2 ? cut.slice(0, line) : cut).trimEnd()}\n…`;
}

/** A file's front matter and the text after it. @param {string} text */
function front(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: /** @type {Record<string, string>} */ ({}), body: text };
  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1].toLowerCase()] = pair[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: text.slice(match[0].length) };
}

/** A file's first heading or first worded line. @param {string} body */
function firstWords(body) {
  const line = body.split(/\r?\n/).find((one) => one.trim());
  return line ? oneLine(line.replace(/^#+\s*/, "")) : "";
}

/** The file names a text links to, by wiki link or Markdown link, without folders or the `.md`. @param {string} text */
function linkNames(text) {
  const out = new Set();
  for (const m of text.matchAll(/\[\[([^\]|\n#]+)/g)) out.add(basename(m[1].trim()).replace(/\.md$/i, ""));
  for (const m of text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/gi)) out.add(basename(m[1]).replace(/\.md$/i, ""));
  return out;
}

/**
 * Every Markdown file under `dir`, dot-folders left out; a folder that cannot be read is nothing.
 * @param {string} dir
 * @param {boolean} deep
 * @returns {string[]}
 */
function markdownIn(dir, deep) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((one) => !one.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((one) => {
      const path = join(dir, one.name);
      if (one.isDirectory()) return deep ? markdownIn(path, deep) : [];
      return one.isFile() && /\.md$/i.test(one.name) ? [path] : [];
    });
}

/** A path as an id's tail: only the characters an id allows. @param {string} path */
const slug = (path) => path.replace(/\.md$/i, "").replace(/[^A-Za-z0-9._/-]+/g, "-");

/** @param {string} path @returns {string} */
function readText(path) {
  return readFileSync(path, "utf8");
}

/** @param {string} path */
function changedAt(path) {
  return Math.round(statSync(path).mtimeMs);
}

/** The time zone's offset from UTC at `t`, in minutes. @param {number} t @param {string | undefined} zone */
function zoneOffset(t, zone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(new Date(t)).find((part) => part.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/**
 * Midnight at the start of a calendar day in the zone, as epoch ms.
 * @param {number} year
 * @param {number} month 0-based
 * @param {number} day
 * @param {string | undefined} [zone]
 */
export function zoneMidnight(year, month, day, zone = process.env.RIVET_TIME_ZONE || undefined) {
  const utc = Date.UTC(year, month, day);
  return utc - zoneOffset(utc - zoneOffset(utc, zone) * 60_000, zone) * 60_000;
}

/** When a dated file was written (a name starting YYYY-MM-DD), else when it last changed. @param {string} path */
function writtenAt(path) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(basename(path));
  return m ? zoneMidnight(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : changedAt(path);
}

/**
 * The most the server takes: the newest nodes, and the links and loaded ids among them.
 * @param {{ built: number, loaded: string[], nodes: any[], links: any[] }} graph
 */
function fit(graph) {
  let nodes = [...graph.nodes].sort((a, b) => (b.written ?? 0) - (a.written ?? 0)).slice(0, NODES_MAX);
  let bytes = nodes.reduce((sum, one) => sum + Buffer.byteLength(JSON.stringify(one)) + 1, 0);
  const linkBytes = graph.links.slice(0, LINKS_MAX).reduce((sum, one) => sum + Buffer.byteLength(JSON.stringify(one)) + 1, 0);
  while (nodes.length && bytes + linkBytes > BYTES_MAX) bytes -= Buffer.byteLength(JSON.stringify(nodes.pop())) + 1;
  if (nodes.length === graph.nodes.length && graph.links.length <= LINKS_MAX) return graph;
  const ids = new Set(nodes.map((one) => one.id));
  const links = graph.links.filter((one) => ids.has(one.source) && ids.has(one.target)).slice(0, LINKS_MAX);
  return { built: graph.built, loaded: graph.loaded.filter((one) => ids.has(one)), nodes, links };
}

/**
 * The graph from the folders named; a folder not named or not there adds nothing.
 * @param {{ memory?: string | null, notes?: string | null, decisions?: string | null, now?: number }} [sources]
 */
export function buildGraph({ memory, notes, decisions, now = Date.now() } = {}) {
  /** @type {any[]} */
  const nodes = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Map<string, string>} a file's bare name to its node id */
  const byName = new Map();
  /** @type {{ id: string, kind: string, text: string }[]} texts whose links are read once every node is known */
  const texts = [];
  /** @type {string | null} */
  let index = null;

  /** @param {any} node @param {string} name @param {string} text */
  const add = (node, name, text) => {
    if (!ID_RE.test(node.id) || node.id.length > ID_MAX || seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
    if (!byName.has(name)) byName.set(name, node.id);
    texts.push({ id: node.id, kind: node.kind, text });
  };
  /** @param {string} raw @param {string} fallback */
  const label = (raw, fallback) => clean(oneLine(raw) || fallback, LABEL_MAX - 2).replace(/\n…$/, "…");

  if (memory) {
    for (const path of markdownIn(memory, false)) {
      const name = basename(path).replace(/\.md$/i, "");
      const text = readText(path);
      const { meta, body } = front(text);
      const written = changedAt(path);
      if (INDEX_RE.test(basename(path))) {
        index = "index";
        add({ id: index, kind: "context", type: "context", label: "Index", desc: "", written, body: clean(body) }, name, body);
        continue;
      }
      const hub = name.startsWith("topic-");
      const type = TYPES.has(meta.type) ? meta.type : "reference";
      const desc = clean(oneLine(meta.description ?? ""), DESC_MAX - 2).replace(/\n…$/, "…");
      add({ id: name, kind: hub ? "hub" : "memory", type, label: label(hub ? (meta.description ?? meta.name ?? "") : (meta.name ?? meta.description ?? ""), name), desc, written, body: clean(body) }, name, body);
    }
  }
  for (const [dir, kind, prefix] of /** @type {const} */ ([
    [notes, "note", "note:"],
    [decisions, "decision", "decision:"],
  ])) {
    if (!dir) continue;
    for (const path of markdownIn(dir, true)) {
      const text = readText(path);
      const { meta, body } = front(text);
      const name = basename(path).replace(/\.md$/i, "");
      const desc = clean(oneLine(meta.description ?? ""), DESC_MAX - 2).replace(/\n…$/, "…");
      add({ id: `${prefix}${slug(relative(dir, path))}`, kind, type: kind, label: label(meta.name ?? meta.title ?? firstWords(body), name), desc, written: writtenAt(path), body: clean(body) }, name, body);
    }
  }

  /** @type {Map<string, { source: string, target: string, kind: string }>} */
  const links = new Map();
  /** @type {Set<string>} */
  const loaded = new Set();
  for (const { id, kind, text } of texts) {
    for (const name of linkNames(text)) {
      const target = byName.get(name);
      if (!target || target === id) continue;
      const key = [id, target].sort().join(" ");
      if (!links.has(key)) links.set(key, { source: id, target, kind: kind === "context" ? "loaded" : kind === "hub" ? "hub" : "wikilink" });
      if (kind === "context") loaded.add(target);
    }
  }
  if (index) loaded.add(index);
  return fit({ built: now, loaded: [...loaded], nodes, links: [...links.values()] });
}

/** @param {string} origin @param {string} token @param {string} body */
async function sendToRivet(origin, token, body) {
  const res = await fetch(`${origin}/api/bridge/mind`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`rivet answered ${res.status}`);
}

/** @param {string[]} argv */
function flags(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`bad flag ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/**
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = flags(argv);
  const now = Date.now();
  const graph = buildGraph({
    memory: opts.memory ?? env.RIVET_MIND_MEMORY_DIR,
    notes: opts.notes ?? env.RIVET_MIND_NOTES_DIR,
    decisions: opts.decisions ?? env.RIVET_MIND_DECISIONS_DIR,
    now,
  });
  const body = JSON.stringify(graph);
  const said = `mind nodes=${graph.nodes.length} links=${graph.links.length} loaded=${graph.loaded.length} bytes=${Buffer.byteLength(body)}`;
  if (opts.out) {
    writeFileSync(opts.out, body);
    console.log(`${new Date(now).toISOString()} ${said} out=${opts.out}`);
    return;
  }
  const state = opts.state ?? join(homedir(), ".rivet-agents", "mind");
  mkdirSync(state, { recursive: true });
  const sentFile = join(state, "sent.json");
  const digest = createHash("sha256").update(JSON.stringify({ ...graph, built: 0 })).digest("hex");
  /** @type {{ digest?: string, at?: number }} */
  let last = {};
  try {
    last = JSON.parse(readFileSync(sentFile, "utf8"));
  } catch {}
  if (last.digest === digest && now - (last.at ?? 0) < RESEND_MS) {
    console.log(`${new Date(now).toISOString()} ${said} unchanged`);
    return;
  }
  const token = await readToken(makeExec(), "RIVET_BRIDGE_TOKEN", env);
  await sendToRivet(serverOrigin(env.RIVET_URL || undefined), token, body);
  writeFileSync(sentFile, JSON.stringify({ digest, at: now }));
  console.log(`${new Date(now).toISOString()} ${said} sent`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`mind-export: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}
