import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { rivetWords, searchNeedles } from "../src/shared/names.js";
import { rankSearch } from "../src/shared/search.js";

const HERE = join(import.meta.dirname, "..");
/** Shipped words: the web app (concepts/ is design history, not shipped) and the server's strings. */
const ROOTS = ["web/src", "src"];
const FILES = [
  "web/index.html",
  "web/public/manifest.webmanifest",
  "web/public/sw.js",
  "web/public/sw-logic.js",
];
/** Strings that keep the old name on purpose, as "<file>: <text>", each with why you never reads it. */
const ALLOWED: [RegExp, string][] = [
  [
    /^src\/shared\/names\.ts: Rivet$/,
    "searchNeedles: the old name a search looks for in stored text",
  ],
];

/** A string you could read with the old name in it. */
const showsOldName = (text: string): boolean => rivetWords(text) !== text;

/** Words a stylesheet puts on screen: `content: "…"`. */
function cssWords(path: string): string[] {
  return [
    ...readFileSync(join(HERE, path), "utf8").matchAll(
      /content:\s*(["'])(.*?)\1/g,
    ),
  ].map((m) => m[2]!);
}

function sources(dir: string): string[] {
  return readdirSync(join(HERE, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory())
        return entry.name === "concepts" ? [] : sources(path);
      return /\.(?:ts|mts|mjs|js|css)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
        ? [path]
        : [];
    },
  );
}

/** Every string and template piece in a module: comments, identifiers and regexes are not words on screen. */
function strings(path: string): string[] {
  const file = ts.createSourceFile(
    path,
    readFileSync(join(HERE, path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      found.push(node.text);
    node.forEachChild(visit);
  };
  visit(file);
  return found;
}

describe("the Rivet name", () => {
  it("no shipped web or server string shows the old name", () => {
    const hits = sources(ROOTS[0]!)
      .concat(sources(ROOTS[1]!))
      .flatMap((path) =>
        (path.endsWith(".css") ? cssWords(path) : strings(path))
          .filter(showsOldName)
          .map((text) => `${relative(".", path)}: ${text}`),
      )
      .concat(
        FILES.flatMap((path) =>
          readFileSync(join(HERE, path), "utf8")
            .split("\n")
            .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
            .filter(showsOldName)
            .map((line) => `${path}: ${line.trim()}`),
        ),
      )
      .filter((hit) => !ALLOWED.some(([allowed]) => allowed.test(hit)));
    expect(hits).toEqual([]);
  });

  it("rivetWords reads the old name as Rivet, case kept, and leaves hostnames, commands and keys alone", () => {
    expect(
      rivetWords("Rivet Ops: a PR waiting only on your video OK"),
    ).toBe("Rivet Ops: a PR waiting only on your video OK");
    expect(rivetWords("Rivet's line, then RIVET again.")).toBe(
      "Rivet's line, then RIVET again.",
    );
    expect(
      rivetWords(
        "Mail Rivet@example.com, Rivet+alerts@example.com or mailto:Rivet@example.com",
      ),
    ).toBe(
      "Mail Rivet@example.com, Rivet+alerts@example.com or mailto:Rivet@example.com",
    );
    const kept =
      "rivet.example.net, rivet claim list, rivet job list, cd rivet, rivet chat set rivet-coming, rivet.chat.draft, rivet:voices, RIVET_TOKEN, @example/rivet, /Rivet/x, Rivety, https://github.com/search?q=Rivet+Ops, q=Rivet";
    expect(rivetWords(kept)).toBe(kept);
  });

  it("search finds a stored old-name title by the name you read", () => {
    const item = {
      kind: "card" as const,
      key: "c1",
      title: "#511 Rivet Ops: a hold card",
      open: { type: "card" as const, id: "c1" },
    };
    expect(rankSearch([item], "Rivet Ops", Date.now())).toEqual([item]);
    expect(rankSearch([item], "rivet ops", Date.now())).toEqual([item]);
    expect(searchNeedles("rivet ops")).toEqual(["rivet ops", "Rivet ops"]);
    expect(searchNeedles("riveting")).toEqual(["riveting", "riveting"]);
  });
});
