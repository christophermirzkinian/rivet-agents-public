import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// A view's own column (a bare class with a max-width, centred) pulls in anything else that wears its class. Board →
// Chats rows wore the Chat view's `.chat`, and stacked as a 760px column; the Town's crew wrapper wore Team Chat's
// `.team`, and the Town drew as a 760px strip on your Mac (2026-10-09). Each column class belongs to one view.

const WEB = join(import.meta.dirname, "../web/src");

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, ext) : name.endsWith(ext) ? [path] : [];
  });
}

/** The bare classes a sheet styles as a centred column: `.name { max-width: <n>…; margin: … auto … }`. */
function columns(): Set<string> {
  const found = new Set<string>();
  for (const sheet of files(WEB, ".css")) {
    const css = readFileSync(sheet, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, list, body] of css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
      if (!/(^|[\s;])max-width\s*:\s*\d/.test(body!) || !/(^|[\s;])margin\s*:[^;]*\bauto\b/.test(body!)) continue;
      for (const selector of list!.split(",")) {
        const bare = /^\.([\w-]+)$/.exec(selector.trim());
        if (bare) found.add(bare[1]!);
      }
    }
  }
  return found;
}

/** Which source files give an element each class, read from their `class:` strings (a `${…}` part dropped). */
function wearers(): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>();
  for (const source of files(WEB, ".ts")) {
    for (const [, literal] of readFileSync(source, "utf8").matchAll(/class(?:Name)?:\s*(`[^`]*`|"[^"]*")/g)) {
      for (const name of literal!.slice(1, -1).replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
        if (name) by.set(name, (by.get(name) ?? new Set()).add(relative(WEB, source)));
      }
    }
  }
  return by;
}

describe("a view's column class", () => {
  it("is worn by that view alone", () => {
    const found = columns();
    // The check reads the sheets it guards: the Chat view's and the Feed's columns are among them.
    expect([...found]).toEqual(expect.arrayContaining(["chat", "feed"]));
    const by = wearers();
    expect(by.get("chat")?.size).toBeGreaterThan(0);
    const shared = [...found].filter((name) => (by.get(name)?.size ?? 0) > 1).map((name) => `${name}: ${[...by.get(name)!].sort().join(", ")}`);
    expect(shared).toEqual([]);
  });
});
