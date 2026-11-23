import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { forcedLog, logForced, mismatch, refusal, registryFileFor, strength } from "../lib/chat-guard.mjs";
import { projectsFromFolders } from "../lib/projects.mjs";

// The open-time guard on a projects root of two folders, as a tree with no project list builds it.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-fixture-"));
for (const folder of ["trip-planner", "recipe-box"]) fs.mkdirSync(path.join(root, folder));
const lists = { projects: projectsFromFolders(root), products: [], worktreeRoots: [] };

test("an ask that names another folder's project is refused in this one, naming both; never in its own", () => {
  const m = mismatch({ ask: "pack the trip planner bags", forced: "recipe-box" }, lists);
  assert.equal(m?.routed.id, "trip-planner");
  assert.equal(refusal(m), `This ask matches trip-planner (${m.why}), not recipe-box. Use --force-project "<reason>" to open it there anyway.`);
  assert.equal(mismatch({ ask: "pack the trip planner bags", forced: "example-org/recipe-box" }, lists)?.routed.id, "trip-planner");
  assert.equal(mismatch({ ask: "pack the trip planner bags", forced: "trip-planner" }, lists), null);
});

test("one word never refuses, and the forced folder's own evidence clears an ask when it is as strong", () => {
  assert.equal(strength({ project: "trip-planner", sure: true, why: "", step: "words", hits: 1 }), 0);
  assert.equal(mismatch({ ask: "add a trip view", forced: "recipe-box" }, lists), null);
  assert.equal(mismatch({ ask: "the recipe box needs a trip planner tab", forced: "recipe-box" }, lists), null);
  // A named project outweighs the other's name.
  assert.equal(mismatch({ ask: "in recipe-box add a trip planner link", forced: "recipe-box" }, lists), null);
  assert.equal(mismatch({ ask: "in recipe-box add a trip planner link", forced: "trip-planner" }, lists)?.routed.id, "recipe-box");
  assert.equal(mismatch({ ask: "", forced: "recipe-box" }, lists), null);
  assert.equal(mismatch({ ask: "pack the trip planner bags", forced: null }, lists), null);
});

test("a product's path forced into another folder's project is refused; the forced project's own product path clears", () => {
  const products = [
    { id: "packing-list", name: "Packing List", folder: "packing-list", packages: [], project: "trip-planner" },
    { id: "shopping-list", name: "Shopping List", folder: "shopping-list", packages: [], project: "recipe-box" },
  ];
  const withProducts = { ...lists, products };
  assert.equal(mismatch({ ask: "fix packing-list/README.md", forced: "recipe-box" }, withProducts)?.routed.id, "trip-planner");
  assert.equal(mismatch({ ask: "fix packing-list/README.md", forced: "trip-planner" }, withProducts), null);
  // Routed alone, the forced project still sees its own product's path, however many of the other's the ask has.
  const mixed = "fix packing-list/a.md, packing-list/b.md and shopping-list/c.md";
  assert.equal(mismatch({ ask: mixed, forced: "trip-planner" }, withProducts), null);
  assert.equal(mismatch({ ask: mixed, forced: "recipe-box" }, withProducts), null);
});

test("the registry is the installed config/ copy first, else the one above the tree", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "guard-fixture-layout-"));
  const tree = path.join(home, "tree");
  const lib = path.join(tree, "bridge", "lib");
  fs.mkdirSync(lib, { recursive: true });
  const above = registryFileFor(lib);
  assert.equal(path.dirname(above), home);
  const installed = path.join(tree, "config", path.basename(above));
  fs.mkdirSync(path.dirname(installed));
  fs.writeFileSync(installed, "[]");
  assert.equal(registryFileFor(lib), installed);
});

test("a forced open appends one private JSON line", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "guard-fixture-log-"));
  logForced({ home, chat: "bags-1", forced: "recipe-box", routed: "trip-planner", reason: "shared notes", now: Date.UTC(2026, 10, 22) });
  const lines = fs.readFileSync(forcedLog(home), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines, [{ time: "2026-11-22T00:00:00.000Z", chat: "bags-1", forced: "recipe-box", routed: "trip-planner", reason: "shared notes" }]);
  assert.equal(fs.statSync(forcedLog(home)).mode & 0o777, 0o600);
});
