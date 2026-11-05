import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { USAGE_BY_ID, USAGE_IDS, type UsageIdKind } from "../src/shared/usage-ids.js";

// What you used (Sam, 27 Oct): every control in the app carries its registry id, and every id in the registry is
// attached to something, so "never used" is complete from day one. This reads web/src's own source with the TypeScript
// parser, not the rendered DOM: mounting every view would miss controls only some states draw, while every control is
// written as an `h("button" | "summary", …)` call, an `h(…)` whose attrs give role switch/tab/option, or a dom.ts
// `button(…)` call. A tag counts only as a literal (or a template's fixed head) in a `"data-use"` attr, button()'s `use`
// argument, a `use:` or `closeUse:` field (sheet.ts, attach.ts), a recorder call, or web/src/usage.ts itself; and a
// dotted registry id written anywhere else (a key's id in a table, a helper's `use` argument) counts as attached,
// unless it sits in a key table whose key nothing else in the file mentions (a dead entry: no handler to record it). A
// template tag covers only the ids that fit its whole shape, and an element with a click handler in an `h(…)` call, or
// a link, carries a tag or its handler records the tap itself.

const WEB = join(import.meta.dirname, "../web/src");
const USAGE_CALLS = new Set(["useTap", "enterScreen", "leaveScreen", "watchDepth"]);
const ROLES = new Set(["switch", "tab", "option"]);

/** Purely visual buttons, by `file › class`: tapping one does nothing a feature does. */
const VISUAL: string[] = [];

/** Registry ids nothing in web/src can attach yet, and why. */
const NOT_ATTACHED: Record<string, string> = {
  // The recorder starts at sign-in: signed out, /api/usage has no session to take a batch.
  gate: "signed out",
};

/** Anchors nobody taps: a link clicked by script to save a file. */
const SCRIPTED = ["views/share.ts"];

interface Control {
  where: string;
  tagged: boolean;
}

interface Tag {
  where: string;
  id: string;
  kind: UsageIdKind;
  /** A template: covers a registry id only if it fits the fixed pieces around the holes, in order. */
  prefix: boolean;
  pieces: string[];
  valued: boolean;
}

/** dom.ts's own `button()` draws the h("button") it tags from its `use` argument. */
const insideButtonHelper = (name: string, node: ts.Node) => {
  for (let up: ts.Node | undefined = node.parent; up; up = up.parent) if (ts.isFunctionDeclaration(up)) return name === "dom.ts" && up.name?.text === "button";
  return false;
};

const files = readdirSync(WEB, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts") && !/\.preview(-entry)?\.ts$/.test(file))
  .map((file) => join(WEB, file));

const controls: Control[] = [];
const tags: Tag[] = [];
/** Registry ids written as plain literals anywhere. */
const loose: string[] = [];
/** Key-table entries nothing else in their file mentions the key of, and so nothing can record. */
const dead: string[] = [];
/** Elements that take a click but carry no tag, and whose handler records no tap. */
const untapped: string[] = [];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A `use:` field names a screen in a sheet's look, a control in photosControl's options. */
const screenUse = (node: ts.PropertyAssignment) => {
  const call = node.parent.parent;
  return !(ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "photosControl");
};

function propName(property: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return null;
  const name = property.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

function prop(object: ts.ObjectLiteralExpression | undefined, name: string): ts.Expression | undefined {
  const found = object?.properties.find((property) => propName(property) === name);
  return found && ts.isPropertyAssignment(found) ? found.initializer : undefined;
}

/** A string tag's literal ids, or a template's fixed head; a conditional gives both sides. */
function literals(node: ts.Expression): { text: string; prefix: boolean; pieces: string[] }[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [{ text: node.text, prefix: false, pieces: [node.text] }];
  if (ts.isTemplateExpression(node)) return [{ text: node.head.text, prefix: true, pieces: [node.head.text, ...node.templateSpans.map((span) => span.literal.text)] }];
  if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  if (ts.isParenthesizedExpression(node)) return literals(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return literals(node.right);
  return [];
}

function addTags(node: ts.Expression, where: string, kind: UsageIdKind, valued: boolean): void {
  for (const { text, prefix, pieces } of literals(node)) if (text || prefix) tags.push({ where, id: text, kind, prefix, pieces, valued });
}

for (const file of files) {
  const name = relative(WEB, file);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const at = (node: ts.Node) => `${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  /** How often each text is written in this file as a string or a property name. */
  const written = new Map<string, number>();
  const tables: { where: string; entries: [key: string, id: string][] }[] = [];
  const calls = (node: ts.Node, callee: string) => {
    let found = false;
    const look = (child: ts.Node): void => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === callee) found = true;
      else ts.forEachChild(child, look);
    };
    look(node);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      written.set(node.text, (written.get(node.text) ?? 0) + 1);
      const entry = USAGE_BY_ID.get(node.text);
      if (entry && entry.kind !== "card" && ((name === "usage.ts" && entry.kind === "screen") || entry.id.includes("."))) loose.push(entry.id);
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) written.set(node.name.text, (written.get(node.name.text) ?? 0) + 1);
    if (ts.isObjectLiteralExpression(node) && node.properties.length > 1) {
      const entries = node.properties.map((property): [string, string] | null => {
        const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
        const key = propName(property);
        return key !== null && value && ts.isStringLiteral(value) && USAGE_BY_ID.get(value.text)?.kind === "control" ? [key, value.text] : null;
      });
      if (entries.every((entry) => entry !== null)) tables.push({ where: at(node), entries: entries as [string, string][] });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      const [first, second] = node.arguments;
      if (callee === "h" && first && ts.isStringLiteral(first)) {
        const props = second && ts.isObjectLiteralExpression(second) ? second : undefined;
        const attrsNode = prop(props, "attrs");
        const attrs = attrsNode && ts.isObjectLiteralExpression(attrsNode) ? attrsNode : undefined;
        const role = prop(attrs, "role");
        const isControl = first.text === "button" || first.text === "summary" || (role !== undefined && literals(role).some((r) => ROLES.has(r.text)));
        const use = prop(attrs, "data-use");
        const onNode = prop(props, "on");
        if (use) addTags(use, at(node), "control", prop(attrs, "data-use-value") !== undefined);
        const click = onNode && ts.isObjectLiteralExpression(onNode) ? prop(onNode, "click") : undefined;
        if (!isControl && !use && ((click && !calls(click, "useTap")) || (first.text === "a" && !SCRIPTED.includes(name)))) untapped.push(`${at(node)} ${first.text}`);
        if (isControl && !insideButtonHelper(name, node)) {
          const cls = prop(props, "class");
          const visual = VISUAL.includes(`${name} › ${cls ? literals(cls)[0]?.text : ""}`);
          controls.push({ where: at(node), tagged: use !== undefined || visual });
        }
      }
      if (callee === "button") {
        const use = node.arguments[4];
        if (use) addTags(use, at(node), "control", node.arguments[5] !== undefined);
        const variant = node.arguments[2];
        const visual = VISUAL.includes(`${name} › ${variant ? literals(variant)[0]?.text : ""}`);
        controls.push({ where: at(node), tagged: (use !== undefined && !(ts.isStringLiteral(use) && use.text === "")) || visual });
      }
      if (callee === "watchDepth" && second) addTags(ts.isArrowFunction(second) && !ts.isBlock(second.body) ? second.body : second, at(node), "screen", false);
      else if (USAGE_CALLS.has(callee) && first) addTags(first, at(node), callee === "useTap" ? "control" : "screen", node.arguments[1] !== undefined);
    }
    if (ts.isPropertyAssignment(node) && propName(node) === "use") addTags(node.initializer, at(node), screenUse(node) ? "screen" : "control", false);
    if (ts.isPropertyAssignment(node) && propName(node) === "closeUse") addTags(node.initializer, at(node), "control", false);
    ts.forEachChild(node, visit);
  };
  visit(source);
  // A table's key is written once in the table itself; a handler that uses it writes it again.
  for (const { where, entries } of tables) {
    for (const [key, id] of entries) if ((written.get(key) ?? 0) < 2) dead.push(`${where} ${JSON.stringify(key)} → ${id}`);
  }
}

const covers = (tag: Tag, id: string) => (tag.prefix ? new RegExp(`^${tag.pieces.map(escape).join(".+")}$`).test(id) : tag.id === id);

const looseLive = loose.filter((id) => !dead.some((entry) => entry.endsWith(`→ ${id}`)));

describe("What you used: every control is named, every name is used", () => {
  it("measured the app: it found the controls and their tags", () => {
    expect(files.length).toBeGreaterThan(95);
    expect(controls.length).toBeGreaterThan(160);
    expect(tags.length).toBeGreaterThan(250);
  });

  it("every button, summary and switch, tab or option carries a data-use", () => {
    expect(controls.filter((control) => !control.tagged).map((control) => control.where).join("\n")).toBe("");
  });

  it("every element that takes a click, and every link, is tagged or records its own tap", () => {
    expect(untapped.join("\n")).toBe("");
  });

  it("every key in a key table has a handler that can record it", () => {
    expect(dead.join("\n")).toBe("");
  });

  it("a template tag covers only the ids that fit its whole shape", () => {
    const id = (text: string) => ({ where: "", id: text, kind: "control" as const, prefix: true, pieces: text.split("${}"), valued: false });
    expect(covers(id("floor.${}.open"), "floor.inhand.open")).toBe(true);
    expect(covers(id("floor.${}.open"), "floor.readings.back")).toBe(false);
    expect(covers(id("floor.${}.open"), "floor.map.place")).toBe(false);
    expect(covers(id("answered.window.${}"), "answered.window.6h")).toBe(true);
  });

  it("every tag is a registry id of its kind, and a position family carries its position", () => {
    const wrong: string[] = [];
    for (const tag of tags) {
      if (tag.prefix) {
        if (!USAGE_IDS.some((entry) => entry.kind === tag.kind && covers(tag, entry.id)) || tag.id.length < 3) wrong.push(`${tag.where} ${tag.id}…`);
        continue;
      }
      const entry = USAGE_BY_ID.get(tag.id);
      if (entry?.kind !== tag.kind) wrong.push(`${tag.where} ${tag.id} is not a ${tag.kind}`);
      else if (tag.kind === "control" && entry.family && !tag.valued) wrong.push(`${tag.where} ${tag.id} has no data-use-value`);
    }
    expect(wrong.join("\n")).toBe("");
  });

  it("every registry control and screen is attached somewhere in web/src", () => {
    const unused = USAGE_IDS.filter(
      (entry) => !entry.meta && !entry.removed && entry.kind !== "card" && !(entry.id in NOT_ATTACHED) && !looseLive.includes(entry.id) && !tags.some((tag) => tag.kind === entry.kind && covers(tag, entry.id)),
    );
    expect(unused.map((entry) => entry.id).join("\n")).toBe("");
  });
});
