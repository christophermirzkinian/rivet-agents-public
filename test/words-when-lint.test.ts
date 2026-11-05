import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// Every shown time goes through when.ts and every state word through words.ts. This walks the web app and src/shared
// and fails on a private date/time format or a replaced state phrase.
// Comments never count: the source is parsed, so only code and string literals are read.

const ROOT = join(import.meta.dirname, "..");
const DIRS = ["web/src", "src/shared"];
const SKIP = new Set(["src/shared/when.ts", "src/shared/words.ts"]);
const isPreview = (file: string) => /\.preview\.ts$/.test(file);

const TIME_OPTIONS = new Set(["hour", "minute", "weekday", "day", "month", "year", "timeZone"]);
const BANNED = [
  "Nothing needs you",
  "Caught up",
  "All clear",
  "On track",
  "Every card answered",
  "Waiting on your OK",
  "waiting for you",
  "Asking you",
  "Waiting on you",
  "Being done",
  "In progress",
  "Rivet is looking into it",
  "time coming",
  "asking for a time",
  "no time given",
  "was due",
  // Lower-case "live" as a state (§3c: Deployed), beside the cased Live below.
  "went live",
  "gone live",
  "goes live",
  "go live",
  "is live",
  "are live",
  "now live",
  "not live",
  "live apps",
  "Bridge live",
  "live reading",
  // A stamp is a clock time (§3d): "6:10pm", never "45m ago" or "just now".
  "ago",
  "just now",
];
// Nothing is live, everyone is testing: the shown state is "Deployed" (deployedAt). Capitalised only, so keys and CSS
// ("is-live", `live`) and words that hold it ("alive", "Deliver") pass.
const CASED = ["Live"];
// Work in hand says its stage (IN_HAND); a whole string that is only one of these is a replaced word.
const EXACT = ["On it", "Investigating", "Picking up", "Working"];
// Never a bare count of late or waiting things (§3d): a late row says its times, a wait says needYou(n). A template's
// expressions are read as a number, so `${n} late` bites.
const COUNTS = [/\b\d+ late\b/, /\b\d+ waiting\b/];
const BANNED_RE = [
  ...BANNED.map((phrase) => ({ phrase, re: new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "i") })),
  ...CASED.map((phrase) => ({ phrase, re: new RegExp(`\\b${phrase}\\b`) })),
];

interface Hit {
  file: string;
  line: number;
  /** The call or the string literal's text. */
  text: string;
}

/** Every private time format and replaced state phrase in one file's code. */
function lint(source: string, file = "sample.ts"): Hit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const add = (node: ts.Node, text: string) => hits.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression.getText(sf).replace(/\s/g, "");
      const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      const timeOptions = (node.arguments ?? []).some(
        (arg) => ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => p.name !== undefined && TIME_OPTIONS.has(p.name.getText(sf))),
      );
      if (/(^|\.)Intl\.DateTimeFormat$/.test(callee) || method === "toLocaleTimeString" || method === "toLocaleDateString" || (method === "toLocaleString" && timeOptions))
        add(node, node.getText(sf));
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text;
      for (const { re } of BANNED_RE) if (re.test(text)) add(node, text);
      if (EXACT.includes(text.trim())) add(node, text);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((span) => `1${span.literal.text}`).join("") : node.text;
      if (COUNTS.some((re) => re.test(text))) add(node, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );
}

/** The exceptions that stay, each with why; the test checks each matches exactly its `hits` (1 unless given), so a new hit in an allowed file still fails. */
const ALLOW: { file: string; pattern: string; why: string; hits?: number }[] = [
  { file: "src/shared/command.ts", pattern: "Rivet is looking into it", why: "a stored record's reason, mirrored by scripts/rivet.mjs and asserted by bridge tests" },
  { file: "web/src/day.ts", pattern: 'new Intl.DateTimeFormat("en-CA"', why: "a key, not shown: the phone's own calendar day as YYYY-MM-DD" },
];

const allowed = (hit: Hit) => ALLOW.some((one) => one.file === hit.file && hit.text.includes(one.pattern));

describe("words-when lint: one time style and one word per state", () => {
  const all = DIRS.flatMap(files)
    .map((path) => relative(ROOT, join(ROOT, path)))
    .filter((file) => !SKIP.has(file) && !isPreview(file))
    .flatMap((file) => lint(readFileSync(join(ROOT, file), "utf8"), file));

  it("finds no private time format or replaced phrase outside the allowlist", () => {
    expect(all.filter((hit) => !allowed(hit)).map((hit) => `${hit.file}:${hit.line} ${hit.text.slice(0, 140)}`)).toEqual([]);
  });

  it("keeps every allowlist entry live, at exactly its count", () => {
    const counted = ALLOW.map((one) => ({ ...one, found: all.filter((hit) => hit.file === one.file && hit.text.includes(one.pattern)).length }));
    expect(counted.filter((one) => one.found !== (one.hits ?? 1)).map((one) => `${one.file} ${one.pattern}: ${one.found}`)).toEqual([]);
  });

  it("bites on a private clock format and on a replaced phrase", () => {
    expect(lint(`const t = new Date().toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });`)).toHaveLength(1);
    expect(lint(`const lede = "All clear";`)).toHaveLength(1);
    expect(lint(`const f = new Intl.DateTimeFormat("en-AU", { hour: "numeric" });`)).toHaveLength(1);
    expect(lint("const at = `was due ${x}`;")).toHaveLength(1);
    expect(lint(`const stage = "Live";`)).toHaveLength(1);
    expect(lint("const meta = `${minutes}m ago`;")).toHaveLength(1);
    expect(lint(`const fresh = "Updated just now";`)).toHaveLength(1);
    expect(lint(`const mood = "On it"; const s = "Investigating"; const q = "Picking up"; const w = "Working";`)).toHaveLength(4);
    expect(lint("const pill = `${late.length} late`;")).toHaveLength(1);
    expect(lint("const pill = `${n} waiting`;")).toHaveLength(1);
    expect(lint(`const line = "3 late";`)).toHaveLength(1);
  });

  it("leaves a lower-case live and words that hold it alone", () => {
    expect(lint(`const k = "is-live"; const a = "alive"; const d = "Deliver"; const s = "live"; const c = "Virago"; const g = "agony";`)).toEqual([]);
    expect(lint("const a = `Working on ${x}`; const b = \"Rivet's on it\"; const c = `${n} more`; const d = \"Late 40 min\"; const e = \"waiting for its first output\";")).toEqual([]);
  });

  it("reads code only: comments, numbers and URLs pass", () => {
    expect(lint(`// All clear\n/* was due 6pm, a week ago */\nconst n = (5).toLocaleString("en-AU");\nconst u = "https://x.test//a";`)).toEqual([]);
  });
});
