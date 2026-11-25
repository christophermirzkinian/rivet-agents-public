// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";

import { cardFieldRefusals, cardFieldsLine, cardsFieldsLine, isAskIdOnly } from "../lib/card-fields.mjs";

const CARD = { id: "c1", kind: "choice", title: "Which look?", ask: "Two looks.\n- Calm\n- Bold", askId: "a-1014", options: [{ label: "Calm", detail: "Dark" }, { label: "Bold", recommended: true }] };

test("a normal card is taken", () => {
  assert.deepEqual(cardFieldRefusals(CARD), []);
  assert.deepEqual(cardFieldRefusals({ ...CARD, rev: "ab", seen: true, schedule: "mac:job", links: [{ label: "Lab", url: "https://x.example", primary: true }] }), []);
  assert.deepEqual(cardFieldRefusals({ id: "t", kind: "todo", title: "Renew the listing", steps: ["Open it"] }), []);
  assert.deepEqual(cardFieldRefusals({ id: "m", kind: "merge-ready", title: "Merge?", pr: 7 }), []);
});

test("the card of 25 Nov is refused whole: each field by its name, with what to use instead", () => {
  const { askId, ...card } = CARD;
  const bad = { ...card, ask: "a-1014", heading: "Usage", bullets: ["one"], options: [{ label: "Calm", id: "a", image: "/tmp/a.png" }] };
  assert.deepEqual(cardFieldRefusals(bad), [
    'a card has no field heading: put it in the ask text (--ask or --ask-file), bullets as lines starting "- "',
    'a card has no field bullets: put it in the ask text (--ask or --ask-file), bullets as lines starting "- "',
    "option 1 has no field id: leave it out: an option is known by its label",
    "option 1 has no field image: put each picture on the card with --still <file>, one per option in the options' order",
    "the ask text is only an ask's id: name the ask with --ask-id a-N (askId in the JSON), and say in --ask what the card asks",
  ]);
  assert.match(cardFieldsLine("c1", cardFieldRefusals(bad)), /^card c1: a card has no field heading: /);
});

test("an unknown field with no better name is told the fields there are, and its own name is never shown long or on two lines", () => {
  assert.match(cardFieldRefusals({ ...CARD, wibble: 1 })[0], /^a card has no field wibble: use one of id, kind, title, ask, /);
  assert.match(cardFieldRefusals({ ...CARD, "a\nb": 1 })[0], /^a card has no field with that name: /);
  assert.deepEqual(cardFieldRefusals({ ...CARD, links: [{ label: "Lab", url: "https://x.example", href: "y" }] }), ["link 1 has no field href: use one of label, url, primary"]);
  assert.match(cardFieldsLine("x".repeat(500_000), ["y"]), /^card x{100}: y$/);
  for (const key of [`ghp_${"A1b2".repeat(9)}`, "A".repeat(36), `AKIA${"A".repeat(16)}`, `sk-${"a".repeat(20)}`]) assert.ok(!cardFieldRefusals({ ...CARD, [key]: 1 })[0].includes(key.slice(0, 20)));
  // A card of any number of fields is refused in a line of a bounded length.
  const many = cardFieldRefusals({ ...CARD, ...Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, 1])) });
  assert.equal(many.length, 10_000);
  assert.match(cardFieldsLine("c1", many), /; and 9994 more problems$/);
  assert.ok(cardFieldsLine("c1", many).length < 4000);
  assert.match(cardsFieldsLine(Array.from({ length: 9 }, (_, i) => `card c${i}: x`)), /^card c0: x; .*card c5: x; and 3 more cards$/);
  // A name every object has is no field of the hint table.
  assert.match(cardFieldRefusals({ ...CARD, constructor: "x" })[0], /^a card has no field constructor: use one of /);
});

test("an ask text that is only an ask's id, with or without an option, is refused; one that says something is not", () => {
  for (const ask of ["a-1014", " a-1014 ", "A-1014", "ask a-1014", "(a-1014)", "a-1010 b", "a-1014:b", "a-1014 (option B)", "a-1014, option 2", "a-1014 option2", "a-1014 (option Yes)"]) assert.ok(isAskIdOnly(ask), ask);
  assert.ok(isAskIdOnly("a-1014: Calm, dark look", ["Bold", "Calm (dark) look"]));
  assert.equal(cardFieldRefusals({ ...CARD, ask: "a-1014 Calm" }).length, 1);
  for (const ask of ["a-1014b", "a-1014 ελα δω", "a-1014 option Yes, or wait","a-1014: which look?", "Pick one for a-1014", "a-1014 and a-1012 both", "Plan A-1 is ready", "", undefined]) assert.ok(!isAskIdOnly(ask), String(ask));
});

test("a decision or choice card with no description is refused, and news (Got it) is not", () => {
  for (const kind of ["decision", "choice"]) {
    for (const ask of [undefined, "", "  \n"]) assert.match(cardFieldRefusals({ id: "c", kind, title: "Ship it?", ask })[0], new RegExp(`^a ${kind} card needs a description: say in --ask`));
  }
  assert.deepEqual(cardFieldRefusals({ id: "c", kind: "decision", title: "Merged", options: [{ label: "Got it" }] }), []);
  assert.deepEqual(cardFieldRefusals({ id: "c", kind: "decision", title: "Ship it?", evidence: { why: "Players asked" } }), []);
});

test("a card edit's body is judged by what it changes: no description needed, and a null takes a field off", () => {
  assert.deepEqual(cardFieldRefusals({ title: "New", heading: null, bullets: null }, { whole: false }), []);
  assert.equal(cardFieldRefusals({ heading: "Usage" }, { whole: false }).length, 1);
  assert.equal(cardFieldRefusals({ ask: "a-1014" }, { whole: false }).length, 1);
});

test("a card stored with the old fields passes as it is, and only what a write adds or changes is refused", () => {
  const stored = { id: "c", kind: "choice", title: "Which?", heading: "Usage", bullets: ["one"], ask: "a-1014", options: [{ label: "A", id: "a", image: "/a.png" }, { label: "B", id: "b" }] };
  assert.deepEqual(cardFieldRefusals({ ...stored, title: "Which one?" }, { stored }), []);
  assert.deepEqual(cardFieldRefusals({ ...stored, options: [stored.options[1], stored.options[0]] }, { stored }), []);
  const { heading, ...without } = stored;
  assert.deepEqual(cardFieldRefusals(without, { stored }), []);
  assert.match(cardFieldRefusals({ ...stored, heading: "Other" }, { stored })[0], /no field heading/);
  assert.match(cardFieldRefusals({ ...stored, options: [{ label: "B", id: "a" }] }, { stored })[0], /option 1 has no field id/);
  assert.match(cardFieldRefusals({ ...stored, ask: "a-1015" }, { stored })[0], /only an ask's id/);
  const bare = { id: "d", kind: "decision", title: "Ship it?" };
  assert.deepEqual(cardFieldRefusals({ ...bare, title: "Ship it now?" }, { stored: bare }), []);
  assert.equal(cardFieldRefusals({ ...CARD, ask: undefined }, { stored: CARD }).length, 1);
  // Compared as they would be stored, whichever side was cleaned.
  const clean = (/** @type {any} */ row) => JSON.parse(JSON.stringify(row).replaceAll("hunter2", "[redacted]"));
  assert.deepEqual(cardFieldRefusals({ ...CARD, heading: "pw [redacted]" }, { stored: { ...CARD, heading: "pw hunter2" }, clean }), []);
});

test("a card's words are judged as they would be stored, and options that are no list of options are refused", () => {
  const clean = (/** @type {any} */ row) => JSON.parse(JSON.stringify(row ?? null).replaceAll("~", ""));
  assert.match(cardFieldRefusals({ ...CARD, ask: "~" }, { clean })[0], /needs a description/);
  assert.match(cardFieldRefusals({ ...CARD, ask: "~a-1014 Calm", options: [{ label: "~Calm" }] }, { clean })[0], /only an ask's id/);
  assert.match(cardFieldRefusals({ id: "u", kind: "update", title: "Look", options: { label: "A", image: "/a.png" } })[0], /^options is not a list/);
  for (const option of ["A", null, [{ image: "/a.png" }]]) assert.match(cardFieldRefusals({ id: "u", kind: "update", title: "Look", options: [option] })[0], /^option 1 is not an option/);
});

test("a card that may be its title alone (say.mjs) still needs an ask that is more than an ask's id", () => {
  const card = { id: "c", kind: "decision", title: "Which look?" };
  assert.deepEqual(cardFieldRefusals(card, { titled: true }), []);
  assert.equal(cardFieldRefusals({ ...card, ask: "a-1014" }, { titled: true }).length, 1);
});
