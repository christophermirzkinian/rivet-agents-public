import assert from "node:assert/strict";
import { test } from "node:test";
import { redactionFindings, redactionReport, redactorChanges, RULE_NAMES, sendRefusal } from "../lib/redact-check.mjs";

// A made-up token shape, built at run time.
const TOKEN = `${["gh", "p_"].join("")}${"A1b2".repeat(9)}`;
// A made-up 64-hex id, the shape of a sha256.
const SHA256 = "a1b2c3d4".repeat(8);
const REFUSED =
  "refused, nothing was sent: the redactor would take this out (a key, token, password, escape code or hidden line), and the board would show [redacted] there. Take it out and send it again:";
const LOOK_ALIKE = "the whole line would be hidden: a look-alike form such as ™ or ² does that, write TM or 2";

test("a message or card the redactor would change is refused by field, line and rule, never by what was found", () => {
  const cases = [
    [`# Creds\n\ntoken: ${TOKEN}\n`, "line 3 (github token)", /A1b2/],
    ["DB_PASSWORD=hunter2hunter2", "line 1 (a value named as a secret)", /hunter|DB_PASSWORD/],
    [["a", "-----BEGIN RSA " + "PRIVATE KEY-----", "MIIabc", "-----END RSA " + "PRIVATE KEY-----", ""].join("\n"), "line 2 (private key)", /MIIabc|BEGIN/],
    ["build \u001b[31mfailed\u001b[0m", "line 1 (a control character or escape)", /\u001b|31m|failed/],
    ["Acme™ ships", `line 1 (${LOOK_ALIKE})`, /Acme|ships/],
    ["ok\ncovers 40 m² today", `line 2 (${LOOK_ALIKE})`, /covers|40|today/],
    // The line's own guess does not hide what only reads as a secret across lines.
    [`the build ${SHA256} is up\npassword:\nswordfish`, "line 3 (a secret read across lines)", /swordfish|a1b2/],
    // Nor do more guesses than a report names hide a line after them.
    [`${`run ${SHA256} ok\n`.repeat(5)}token ${TOKEN}`, "line 6 (github token)", /A1b2|a1b2/],
    // A value the redactor takes out for its place, at any length, is no long-id guess.
    [`db is ${["postgres:", "", "app:Hunter2pwHunter2pw"].join("/")}@db.internal/app`, "line 1 (a secret-shaped value)", /Hunter/],
    ["run mysql -u root -pHunter2pwHunter2pw prod", "line 1 (a secret-shaped value)", /Hunter/],
    [`send ${["Bea", "rer"].join("")} Hunter2pwHunter2pwHunter2pw with it`, "line 1 (a secret-shaped value)", /Hunter/],
    // A long id under a line that names it a secret is one, read across the lines.
    [`password:\n${SHA256}`, "line 2 (a secret read across lines)", /a1b2/],
    // One word hidden whole for a look-alike form.
    ["Acme™", `line 1 (${LOOK_ALIKE})`, /Acme/],
    // A value stuck to its flag, and a short one after a command named by its path, are no long id either.
    ["redis-cli -h cache -aHunter2pwHunter2pw ping", "line 1 (a secret-shaped value)", /Hunter/],
    ["run /usr/local/bin/mysql -u root -phunter2 now", "line 1 (a secret-shaped value)", /hunter/],
    ["mysql -u root -p correcthorsebatterystaple", "line 1 (a secret-shaped value)", /horse/],
  ];
  for (const [text, found, secret] of cases) {
    const { refusal } = sendRefusal([["--text", text]]);
    assert.equal(refusal, `${REFUSED}\n  --text: ${found}`);
    assert.doesNotMatch(refusal, /** @type {RegExp} */ (secret));
  }
  // Only the field with something to take out is named; one that is no text is passed over.
  assert.deepEqual(sendRefusal([["--title", "Nightly"], ["--ask", `x\n${TOKEN}`], ["--tag", undefined], ["--eta", 5], ["--thread", ""], ["--why", "K_TOKEN=abcdef1abcdef"]]), {
    refusal: `${REFUSED}\n  --ask: line 2 (github token)\n  --why: line 1 (a value named as a secret)`,
    notes: [],
  });
  assert.deepEqual(sendRefusal([["--tag", undefined], ["--eta", 5], ["--points", [TOKEN]], ["--thread", ""], ["--why", null]]), { refusal: null, notes: [] });
});

test("text the redactor leaves alone, a home folder, and a long id it only guesses at are sent", () => {
  const home = ["", "Users", "tester"].join("/");
  for (const text of ["All green, merging now.", "see ~/x for the log", `merged at ${"a1b2c3d4e5".repeat(4)} on main`, "PR https://example.com/pull/8988 is up", "A → B — “quoted” … ×"])
    assert.deepEqual(sendRefusal([["--text", text]], home), { refusal: null, notes: [] }, text);
  // The board shows a home folder as ~, which loses nothing.
  for (const text of [`log at ${["", "Users", "someone"].join("/")}/work/x.log`, `a\nlog at ${home}/work/x.log`]) {
    assert.notDeepEqual(redactionFindings(text), [], text);
    assert.deepEqual(sendRefusal([["--text", text]], home), { refusal: null, notes: [] }, text);
  }
  assert.deepEqual(sendRefusal([["--title", "Build"], ["--text", `ok\nthe build ${SHA256} is on the site`]], home), {
    refusal: null,
    notes: ["--text: line 2 holds a long token-shaped value; the board shows [redacted] in its place"],
  });
  // A padded base64 digest, and a long id beside a long path, are guesses too.
  for (const text of ["digest q1MKE+RZFJgrefm3V6m+tq2OCQ9Vuw/V7rSZPQ7f6b0=", `/usr/local/bin/node built ${SHA256}`])
    assert.deepEqual(sendRefusal([["--text", text]], home), { refusal: null, notes: ["--text: line 1 holds a long token-shaped value; the board shows [redacted] in its place"] }, text);
  const { refusal, notes } = sendRefusal([["--ask", `${SHA256}\nfine\nand ${SHA256} too`]], home);
  assert.equal(refusal, null);
  assert.deepEqual(notes, ["--ask: line 1, line 3 hold a long token-shaped value; the board shows [redacted] in its place"]);
  assert.doesNotMatch(notes.join(), /a1b2/);
});

test("the findings behind a report give each line's number, its rules and whether the whole line goes", () => {
  assert.deepEqual(redactionFindings(`a\ntoken: ${TOKEN}\nx ${SHA256} y`), [
    { line: 2, rules: ["github token"], blanked: false },
    { line: 3, rules: ["a secret-shaped value"], blanked: false },
  ]);
  assert.deepEqual(redactionFindings("Acme™ ships"), [{ line: 1, rules: ["a secret-shaped value"], blanked: true }]);
  assert.deepEqual(redactionFindings("password:\nswordfish"), [{ line: 2, rules: ["a secret read across lines"], blanked: false }]);
  assert.deepEqual(redactionFindings("plain words"), []);
});

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
