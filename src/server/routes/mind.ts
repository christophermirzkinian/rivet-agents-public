import { gzipSync } from "node:zlib";

import { mindMarksGone, mindPutSchema, MIND_MAX_BYTES, MIND_QUERY_MAX, type MindPutResponse, type MindSearchResponse } from "../../shared/mind.js";
import { json, readJson, requireBearer } from "../httputil.js";
import { MindStore } from "../mind.js";
import { parseRedacted, redactText } from "../redact.js";
import type { Router } from "./router.js";

// More › Rivet's mind: scripts/mind-export.mjs sends the whole graph with the bridge token, and the app reads it with
// the owner's session: the dots and links first, a node's words on a tap.

const CUT = "[redacted]";

/** Markdown read with every word it hides kept: a link as its words and its target, a wiki link with its other name. */
function marksAsText(s: string): string {
  for (;;) {
    const next = s
      .replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, "$1 $2")
      .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1 $2")
      .replace(/\*\*|`/g, "");
    if (next === s) return s;
    s = next;
  }
}

// Every step from a line as sent to its shown form, as the sheet takes them and with link targets kept. Each step is
// read, not only the last: a later step can join a scheme to the word before it ("a**Basic" to "aBasic") and lose what
// an earlier one shows.
function steps(s: string, targets: boolean): string[] {
  const out = [s];
  const step = (next: string): void => {
    if (next !== s) out.push((s = next));
  };
  for (;;) {
    const round = s;
    step(s.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, targets ? "$1 $2" : "$1"));
    step(s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, targets ? "$1 $2" : "$1"));
    step(s.replace(/\*\*|`/g, ""));
    if (s === round) return out;
  }
}

/**
 * The lines a reading by the line redactor would change. Each line is read in every form the page can show or hide:
 * as shown (mindMarksGone); with the marks gone but every hidden word kept;
 * and at every step from as sent to shown with link targets kept, so a command named only in a link target meets a
 * flag only the shown form makes plain, and a scheme a later step would join to the word before it is still read. Each
 * line is also read joined to the next line that has words, and the token characters at its end joined to those at
 * that line's start, so a scheme and its secret, or a token, over two lines (a description's last and a body's first
 * too) are read as one. The line redactor reads prose as prose; the
 * whole-text reader takes every row after a `key:` and would blank ordinary memories.
 */
// A secret cut over two lines leaves a few token characters each side; one letter and a word ("s" "EXAMPLE_HEAD") do not.
// Any rule on the characters themselves lets some key through, so a heading and the word under it may be cut too.
const cutToken = (tail: string, head: string): boolean => tail.length >= 4 && head.length >= 4;

// Two word characters a removed mark or a link's brackets would put side by side ("a**Basic", "x[a](b)", "[[a]]b").
const JOINS = /\w(?:\*\*|`)+\w|\w\[\[|\w\[[^\]\n]+\]\(|\]\]\w|\[[^\]\n]+\]\([^)\n]+\)\w/;

function flagged(sent: string[], shown: string[]): Set<number> {
  const kept = sent.map((line) => steps(line, true));
  const taken = sent.map((line) => steps(line, false));
  const forms = [shown, sent.map((line) => marksAsText(line))];
  // The k-th step of every line (or its last), so a line pair is read at the same step.
  for (const each of [kept, taken]) {
    const most = Math.max(0, ...each.map((line) => line.length));
    for (let k = 0; k < most; k++) forms.push(each.map((line) => line[Math.min(k, line.length - 1)]!));
  }
  // What the sheet hides (link targets, a wiki link's other name) read before each line it shows, so a scheme kept in a
  // target meets a secret the sheet shows anywhere in the node.
  const hidden = [
    ...new Set([...sent.join("\n").matchAll(/\]\(([^)\n]+)\)|\[\[[^\]|\n]+\|([^\]\n]*)\]\]/g)].map((m) => (m[1] ?? m[2] ?? "").trim()).filter(Boolean)),
  ];

  const out = new Set<number>();
  const read = new Map<string, string>();
  const redacted = (text: string): string => {
    let known = read.get(text);
    if (known === undefined) read.set(text, (known = redactText(text)));
    return known;
  };
  // A step that joins two words (marks or a link between token characters) can hide a scheme or make a token no
  // reading sees whole, in endless combinations; such a line is cut with the worded lines either side of it.
  const worded = sent.flatMap((line, i) => (line.trim() ? [i] : []));
  kept.forEach((each, i) => {
    if (!each.some((step) => JOINS.test(step))) return;
    const at = worded.indexOf(i);
    for (const j of [worded[at - 1], i, worded[at + 1]]) if (j !== undefined) out.add(j);
  });
  for (const lines of forms) {
    // Each line on its own.
    lines.forEach((line, i) => {
      if (redacted(line) !== line) out.add(i);
    });
    // Each line with the next worded line, so a scheme and its secret over two lines (a description's last and a body's
    // first too) are read together; and the token characters at the end of one and the start of the next, as one token.
    let next = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      if (next < lines.length) {
        const tail = /[\w+/=-]+$/.exec(line)?.[0];
        const head = /^\s*([\w+/=-]+)/.exec(lines[next]!)?.[1];
        const pair = `${line} ${lines[next]}`;
        if (redacted(pair) !== pair || (tail && head && cutToken(tail, head) && redacted(`${tail}${head}`) !== `${tail}${head}`)) out.add(i).add(next);
      }
      next = i;
    }
  }
  if (hidden.length) {
    const most = Math.max(0, ...taken.map((line) => line.length));
    for (let k = 0; k <= most; k++) {
      const lines = k === most ? shown : taken.map((line) => line[Math.min(k, line.length - 1)]!);
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        for (const target of hidden) if (!redacted(`${target} ${line}`).endsWith(` ${line}`)) out.add(i);
      });
    }
  }
  return out;
}

const SEEN_MAX = 10_000;
const seen = new Map<string, { desc: string; body: string }>();

/**
 * A node's words kept as its sheet shows them, each line whole or cut: description then body read as one text in every
 * reading flagged() makes, and a line any of them would change kept as "[redacted]". A map is sent every few minutes
 * with most nodes unchanged, so an answer is kept for the next map.
 */
export function redactNode(desc: string, body: string): { desc: string; body: string } {
  const key = `${desc}\u0000${body}`;
  const known = seen.get(key);
  if (known) return known;
  const cut = desc.split("\n").length;
  const sent = `${desc}\n${body}`.split("\n");
  const shown = mindMarksGone(sent.join("\n")).split("\n");
  for (const i of flagged(sent, shown)) shown[i] = CUT;
  const kept = { desc: shown.slice(0, cut).join("\n"), body: shown.slice(cut).join("\n") };
  if (seen.size >= SEEN_MAX) seen.delete(seen.keys().next().value!);
  seen.set(key, kept);
  return kept;
}

/** A dot's name as the map shows it: kept only when no reading of it would change. */
export function redactLabel(label: string): string {
  return flagged([label], [mindMarksGone(label)]).size ? CUT : label;
}

export function register(router: Router): void {
  const { config, requireSession, now } = router.deps;
  const mind = new MindStore(config.dataDir);
  router.onClose(() => mind.close());

  router.on("PUT", "/api/bridge/mind", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(mindPutSchema, await readJson(request, MIND_MAX_BYTES));
    if (!parsed.success) {
      json(response, 400, { error: "invalid mind graph", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    // The Mac and parseRedacted read a line at a time; each node's words are read again in every form the page shows.
    const nodes = [];
    let since = Date.now();
    for (const node of parsed.data.nodes) {
      nodes.push({ ...node, label: redactLabel(node.label), ...redactNode(node.desc, node.body) });
      // A first map is read in turns, so the server answers the app between them.
      if (Date.now() - since > 20) {
        await new Promise((resolve) => setImmediate(resolve));
        since = Date.now();
      }
    }
    const graph = { ...parsed.data, nodes };
    mind.put(graph, now());
    const body: MindPutResponse = { ok: true, nodes: parsed.data.nodes.length, links: parsed.data.links.length };
    json(response, 200, body);
  });

  // The dots and links are ~430 KB of JSON and nothing on the way compresses it: gzipped they are ~80 KB.
  router.on("GET", "/api/mind", ({ request, response }) => {
    requireSession(request);
    const body = mind.read();
    if (!/\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""))) {
      json(response, 200, body);
      return;
    }
    const payload = gzipSync(JSON.stringify(body));
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-encoding": "gzip", "content-length": payload.length, "cache-control": "no-store", vary: "accept-encoding" });
    response.end(payload);
  });

  router.on("GET", "/api/mind/node", ({ request, response, url }) => {
    requireSession(request);
    const node = mind.node(url.searchParams.get("id") ?? "");
    if (!node) {
      json(response, 404, { error: "no such node" });
      return;
    }
    json(response, 200, node);
  });

  router.on("GET", "/api/mind/search", ({ request, response, url }) => {
    requireSession(request);
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, MIND_QUERY_MAX);
    const body: MindSearchResponse = { ids: query ? mind.search(query) : [] };
    json(response, 200, body);
  });
}
