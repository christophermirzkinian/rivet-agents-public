import assert from "node:assert/strict";
import { test } from "node:test";
import { redactionReport, redactorChanges, RULE_NAMES } from "../lib/redact-check.mjs";

// A made-up token shape, built at run time.
const TOKEN = `${["gh", "p_"].join("")}${"A1b2".repeat(9)}`;

test("a refusal names each line and the rule that fired, never what was found", () => {
  const cases = [
    [`# Creds\n\ntoken: ${TOKEN}\n`, "line 3 (github token)"],
    ["a\nDB_PASSWORD=hunter2hunter2\nok", "line 2 (a value named as a secret)"],
    ["build \u001b[31mfailed\u001b[0m\n", "line 1 (a control character or escape)"],
    [["a", "-----BEGIN RSA " + "PRIVATE KEY-----", "MIIabc", "-----END RSA " + "PRIVATE KEY-----", ""].join("\n"), "line 2 (private key)"],
    ["x `7F3A9C2E5B8D1F4A6C0E9B3D7A5F2C18` y", "line 1 (a secret-shaped value)"],
    [`a\nb\n${"ab.".repeat(80000)}`, "line 3 (a line over 4096 characters)"],
  ];
  for (const [text, report] of cases) {
    assert.equal(redactorChanges(text), true, report);
    assert.equal(redactionReport(text), report);
  }
  // A literal marker in the text is never read back as a rule's name.
  assert.equal(redactionReport("x [redacted hunter] DB_PASSWORD=hunter2hunter2"), "line 1 (a value named as a secret)");
  const many = Array.from({ length: 8 }, (_, i) => `K${i}_TOKEN=abcdef${i}abcdef`).join("\n");
  assert.equal(redactionReport(many).split("), line").length, 5, "at most five lines are named");
  for (const text of ["# Notes\n\nplain words\n", "id,amount\n1,12.50\n", "\tindented\n"]) {
    assert.equal(redactorChanges(text), false, text);
    assert.equal(redactionReport(text), "");
  }
});

test("a marker spelled in a document, a tab for its space, never names a rule", () => {
  for (const text of [`password:\n[redacted\tswordfish] ${TOKEN}`, "password:\n[redacted correct\thorse battery staple] TOKEN=x"]) {
    const report = redactionReport(text);
    assert.match(report, /^line 2 \(/);
    assert.doesNotMatch(report, /swordfish|horse|battery|staple|A1b2/);
  }
});

test("the rule names a refusal may give are the redactor's own markers", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../redactor/redact.mjs", import.meta.url), "utf8");
  const names = new Set([...source.matchAll(/"\[redacted ([a-z ]+)\]"/g)].map(([, name]) => name));
  assert.ok(names.size > 0);
  assert.deepEqual([...names].sort(), [...RULE_NAMES].sort());
});
