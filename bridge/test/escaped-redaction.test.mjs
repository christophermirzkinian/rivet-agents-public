import assert from "node:assert/strict";
import test from "node:test";
import { redactLine, redactLines } from "../lib/redact.mjs";

// The linear-time guards below time CPU, not the wall clock: a loaded runner stalls a run until its CPU quota
// refills, while a quadratic or backtracking parse still costs the CPU it always did.
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

// Synthetic fixtures only; no credential files or URL parsing.
const TOKEN = ["gh", "p_"].join("") + "MadeUpFixture1234567890AbCd";
const USERS = ["", "Users", ""].join("/");
const RANDOM = "Q7m2V9z4R1p6K8w3J5n0";
const encoders = {
  unicode: (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`,
  braces: (c) => `\\u{${c.codePointAt(0).toString(16)}}`,
  long: (c) => `\\U${c.codePointAt(0).toString(16).padStart(8, "0")}`,
  hex: (c) => `\\x${c.codePointAt(0).toString(16).padStart(2, "0")}`,
  octal: (c) => `\\${c.codePointAt(0).toString(8).padStart(3, "0")}`,
  printf: (c) => `\\0${c.codePointAt(0).toString(8).padStart(3, "0")}`,
  identity: (c) => `\\${c}`,
};
const encode = (text, encoder) => Array.from(text, encoder).join("");

for (const [name, encoder] of Object.entries(encoders)) {
  test(`${name} credentials and heuristic tokens are withheld`, () => {
    for (const value of [TOKEN, RANDOM, "password=made-up-small-value"]) {
      assert.equal(redactLine(`result ${encode(value, encoder)}`), "[redacted]");
    }
  });
  test(`${name} secret headers hold later batches`, () => {
    const state = { inKey: false };
    assert.deepEqual(redactLines([encode("password:", encoder)], state), ["[redacted]"]);
    assert.deepEqual(redactLines(["made-up-small-value", "", "later"], { ...state }), ["[redacted]", "", "[redacted]"]);
  });
}

test("nested, mixed and identity escapes cannot split tokens or labels", () => {
  const mixed = encode(TOKEN, (c, i) => Object.values(encoders)[i % 6](c));
  for (const value of [
    mixed,
    encode(encode(TOKEN, encoders.printf), encoders.hex),
    encode(encode(TOKEN, encoders.unicode), encoders.octal),
    TOKEN.replace("ghp", String.raw`\g\h\p`),
    encode(["gh", "p_"].join("") + "MadeUpCredential0123456789", encoders.identity),
    encode(encode(["gh", "p_"].join("") + "MadeUpCredential0123456789", encoders.identity), encoders.hex),
    String.raw`\p\a\s\s\w\o\r\d:`,
    String.raw`\N{LATIN SMALL LETTER A}`,
    String.raw`\u{110000}`,
    "\\".repeat(256) + "diagnostic",
  ]) assert.equal(redactLine(value), "[redacted]");
});

test("inspection precedes display truncation and preserves plain diagnostics", () => {
  assert.equal(redactLine("ordinary ".repeat(400) + encode(TOKEN, encoders.hex)), "[redacted]");
  for (const line of ["build completed in 42ms", "src/worker.ts:12:4", String.raw`hello\u0020world`, String.raw`escaped \\ slash`]) {
    assert.equal(redactLine(line), line);
  }
  assert.deepEqual(redactLines(["intro", "build completed", "next: fine"]), ["intro", "build completed", "next: fine"]);
});

test("complete escaped standalone tokens release later diagnostics", () => {
  for (const escaped of [String.raw`\x67hp_MadeUpFixture1234567890AbCd`, encode(TOKEN, encoders.unicode)]) {
    const state = { inKey: false };
    assert.deepEqual(redactLines([escaped], state), ["[redacted]"]);
    assert.deepEqual(redactLines(["build completed", "next: fine"], state), ["build completed", "next: fine"]);
  }
});

test("encoded collection headers retain state across later batches", () => {
  for (const header of [String.raw`password\x3a\x5b`, String.raw`password\x3a\x7b`, String.raw`\p\a\s\s\w\o\r\d\x3a\x5b`]) {
    const state = { inKey: false };
    assert.deepEqual(redactLines([header], state), ["[redacted]"]);
    assert.deepEqual(redactLines(["made-up-value", "]", "later"], state), ["[redacted]", "[redacted]", "[redacted]"]);
  }
});

test("physical continuations withhold every fragment across batches", () => {
  for (const logical of ["PASSWORD=made-up-value", TOKEN]) {
    const chunks = logical.match(/.{1,4}/g);
    const state = { inKey: false };
    for (const chunk of chunks.slice(0, -1)) assert.deepEqual(redactLines([`${chunk}\\`], state), []);
    const out = redactLines([chunks.at(-1), "build completed"], state);
    assert.match(out[0], /\[redacted/);
    assert.ok(!out[0].includes("made-up-value"));
    assert.equal(out.at(-1), "build completed");
    assert.match(redactLine(chunks.join("\\\n")), /\[redacted/);
    assert.match(redactLine(chunks.join("\\\r\n")), /\[redacted/);
  }
});

test("standard controls and mixed per-escape interpretations are inspected", () => {
  for (const control of "abefnrtv") {
    const escaped = `${TOKEN.slice(0, 3)}\\${control}${TOKEN.slice(3)}`;
    assert.equal(redactLine(escaped), "[redacted]");
  }
  for (const separator of [String.raw`\t`, String.raw`\n`, String.raw`\r`, String.raw`\f`, String.raw`\v`]) {
    assert.equal(redactLine(`Bearer${separator}tinyfake`), "[redacted]");
  }
  for (const escaped of [String.raw`Q7m2V9z4R1p6K8\3\065`, String.raw`\x67\h\p\_MadeUpCredential\3\065fixture`, String.raw`\xC3\xA9`]) {
    assert.equal(redactLine(escaped), "[redacted]");
  }
});

test("oversized continued logical lines fail closed without publishing fragments", () => {
  const state = { inKey: false };
  assert.deepEqual(redactLines(["a".repeat(64000) + "\\"], state), []);
  assert.deepEqual(redactLines(["b".repeat(2000), "made-up-value"], state), ["[redacted]", "[redacted]"]);
});

test("raw masking cannot hide an escaped curl credential or collection boundary", () => {
  for (const line of [String.raw`curl -u $'fakeuser\x3afakepass'`, String.raw`curl -u $'fakeuser\u003afakepass'`, String.raw`curl -u fakeuser\:tinyfake`]) {
    for (const output of [redactLine(line), ...redactLines([line])]) {
      assert.match(output, /\[redacted\]/);
      assert.ok(!/fakepass|tinyfake/.test(output));
    }
  }
  for (const header of [String.raw`password:\x5b`, String.raw`password:\x7b`, String.raw`password:\[`]) {
    const state = { inKey: false };
    redactLines([header], state);
    redactLines(Array(35).fill("# padding"), state);
    assert.deepEqual(redactLines(["tinyfake", "]"], state), ["[redacted]", "[redacted]"]);
  }
});

test("display controls after a continuation cannot publish its fragments", () => {
  for (const suffix of ["\x1b[0m", "\x00"]) {
    const state = { inKey: false };
    assert.deepEqual(redactLines(["PASS\\" + suffix], state), []);
    assert.deepEqual(redactLines(["WORD=tinyfake", "build completed"], state), ["PASSWORD=[redacted]", "build completed"]);
  }
  // An invisible character stays in the line: the backslash escapes a character no reading shows, so the stream holds.
  const state = { inKey: false };
  assert.deepEqual([...redactLines(["PASS\\\u200b"], state), ...redactLines(["WORD=tinyfake", "build completed"], state)], ["[redacted]", "[redacted]", "[redacted]"]);
});

test("line-only escape masking still advances an existing secret collection", () => {
  const state = { inKey: false };
  const lines = ['{"password":', '["\\x67hp_MadeUpFixture1234567890AbCd",', '"pad",', '"tinyfake"', "]}"];
  const output = lines.flatMap((line) => {
    const result = redactLines([line], state);
    // Exercise parser state independently from its 30-line fallback floor.
    state.hold = 0;
    return result;
  });
  assert.ok(!output.join("\n").includes("tinyfake"));
  assert.deepEqual(redactLines(["build completed"], state), ["build completed"]);
});

test("uncertain fully hex-escaped tokens retain the stream hold", () => {
  const state = { inKey: false };
  assert.deepEqual(redactLines([encode("sk-MadeUpFixture1234567890AbCd", encoders.hex)], state), ["[redacted]"]);
  assert.equal(state.rest, true);
  assert.deepEqual(redactLines(["build completed", "next: fine"], state), ["[redacted]", "[redacted]"]);
});

test("variable-width C hex is refused directly and behind another layer", () => {
  for (const line of [["gh", "p_"].join("") + String.raw`MadeUpFixtur\x0065fixture`, encode(["gh", "p_"].join("") + String.raw`MadeUpFixtur\x0065fixture`, encoders.unicode)]) {
    assert.equal(redactLine(line), "[redacted]");
  }
});

test("ordinary multi-line JSON diagnostics survive without retaining a hold", () => {
  for (const trace of [Array(9).fill("ordinary step"), Array.from({ length: 12 }, (_, i) => `step ${i}`), Array(10).fill("stage alpha")]) {
    const text = JSON.stringify({ trace: trace.join("\n") });
    assert.equal(redactLine(text), text);
    const state = { inKey: false };
    assert.deepEqual(redactLines([text, "build completed"], state), [text, "build completed"]);
  }
});

test("control-only certificate retains every named-secret and redaction-rule family", () => {
  const names = ["SECRET", "TOKEN", "PASSWORD", "PASSWD", "PASSPHRASE", "PASS", "API_KEY", "ACCESS_KEY", "PRIVATE_KEY", "CLIENT_KEY", "CREDENTIALS", "AUTH", "SESSION", "COOKIE", "DSN", "DATABASE_URL", "CONNECTION_STRING", "SIGNING_KEY", "WEBHOOK"];
  const witnesses = [
    ...names.map((name) => `${name}=tinyfake`),
    ["-----BEGIN", "PRIVATE KEY-----"].join(" "), ["github", "pat", ""].join("_") + "MadeUpFixture1234567890AbCd", TOKEN,
    ...["gho_", "ghu_", "ghs_", "ghr_", "sk-ant-", "sk-"].map((prefix) => prefix + "MadeUpFixture1234567890AbCd"),
    ...["AKIA", "ASIA", "AGPA", "AIDA", "AROA", "ANPA"].map((prefix) => prefix + "ABCDEFGHIJKLMNOP"),
    ["xo", "xb-"].join("") + "made-up-fixture-123456", ["AI", "za"].join("") + "MadeUpFixture1234567890AbCd0123456789", "eyJabcdef.abcdefghi.abcdefghi",
    "Bearer tinyfake", "Basic tinyfake", "Token tinyfake", "https://fakeuser:tinyfake@example.invalid/", "?key=tinyfake", "?sig=tinyfake",
    '{"password":"tinyfake"}', "--password tinyfake", "mysql -p tinyfake", "mariadb -p tinyfake", "sshpass -p tinyfake", "redis-cli -a tinyfake",
    "curl -u fakeuser:tinyfake", "curl --proxy-user fakeuser:tinyfake", "zip -P tinyfake", "7z -p tinyfake",
  ];
  for (const witness of witnesses) {
    const hidden = witness[0] + String.raw`\n` + witness.slice(1);
    const text = String.raw`ordinary step\n`.repeat(9) + hidden;
    assert.match(redactLine(text), /\[redacted/);
  }
});

test("control-only proof cannot skip immutable characters or nested escape syntax", () => {
  const text = String.raw`ordinary step\n`.repeat(9) + String.raw`pa\nssword:tinyfake`;
  assert.equal(redactLine(text), "[redacted]");
  for (const middle of [String.raw`\x5c\n`, "\\".repeat(3) + "n"]) {
    assert.equal(redactLine(TOKEN.slice(0, 4) + middle + TOKEN.slice(4)), "[redacted]");
  }
});

test("decoded nested brackets and changed quote contexts retain every reading", () => {
  for (const header of [
    String.raw`password: [\x5b`,
    String.raw`password: {\x7b`,
    String.raw`password: [\x22`,
    String.raw`password: ["\x22\x5b`,
    String.raw`password: ['\x27\x5b`,
  ]) {
    const state = { inKey: false };
    redactLines([header], state);
    redactLines(["],", ...Array(35).fill("# padding")], state);
    assert.deepEqual(redactLines(["tinyfake", "]"], state), ["[redacted]", "[redacted]"]);
    assert.equal(state.rest, true);
  }
});

test("ordinary secret-name prose needs assignment syntax to retain a hold", () => {
  for (const phrase of ["session closed", "Session closed", "auth ended", "cookie rotated", "pass done", "credential end"]) {
    const text = JSON.stringify({ trace: Array(9).fill(phrase).join("\n") });
    const state = { inKey: false };
    assert.equal(redactLine(text), text);
    assert.deepEqual(redactLines([text], state), [text]);
    assert.deepEqual(redactLines(["build completed"], state), ["build completed"]);
    assert.notEqual(state.rest, true);
  }
});

test("assignment certificate covers suffixes, closing quotes, spaces, and flags", () => {
  const prefix = String.raw`ordinary step\n`.repeat(9);
  for (const tail of [
    String.raw`sess\nion_id = tinyfake`,
    String.raw`sess\nion.foo: tinyfake`,
    String.raw`"sess\nion" : tinyfake`,
    String.raw`'sess\nion'\t= tinyfake`,
    String.raw`--sess\nion tinyfake`,
    String.raw`pri\nvate_key:`,
  ]) assert.equal(redactLine(prefix + tail), "[redacted]");
});

test("already tracked raw scalar escapes keep surgical masking and the existing finite hold", () => {
  const state = { inKey: false };
  assert.deepEqual(redactLines([String.raw`password: "fake\nvalue"`], state), ['password: "[redacted]"']);
  assert.notEqual(state.rest, true);
  redactLines(Array(30).fill("padding"), state);
  assert.deepEqual(redactLines(["build completed"], state), ["build completed"]);
});

test("controls-only credential uncertainty redacts one line without silencing later logs", () => {
  for (const phrase of ["token expired", "Bearer unavailable", "Basic unavailable", "Q7m2V9z4R1p6K8w3J5n0"]) {
    const trace = JSON.stringify({ trace: Array(9).fill(phrase).join("\n") });
    const state = { inKey: false };
    assert.deepEqual(redactLines([trace], state), ["[redacted]"]);
    assert.notEqual(state.rest, true);
    assert.deepEqual(redactLines(["build completed", "next: fine"], state), ["build completed", "next: fine"]);
  }
});

test("structural-only proof retains assignments, flags, and private-key boundaries", () => {
  const prefix = String.raw`ordinary step\n`.repeat(9);
  for (const suffix of [
    String.raw`pa\nssword: [`,
    String.raw`--sess\nion tinyfake`,
    String.raw`curl -\nu fakeuser:tinyfake`,
    String.raw`-----BEGIN PRI\nVATE KEY-----`,
  ]) {
    const state = { inKey: false };
    redactLines([prefix + suffix], state);
    assert.equal(state.rest, true);
    assert.deepEqual(redactLines(["tinyfake", "later"], state), ["[redacted]", "[redacted]"]);
  }
});

test("structurally safe uncertain lines still advance an existing secret collection", () => {
  const trace = JSON.stringify({ trace: Array(9).fill("token expired").join("\n") });
  const state = { inKey: false };
  const output = redactLines(["password: [", trace, ...Array(35).fill("# padding"), "tinyfake", "]", "build completed"], state);
  assert.ok(!output.join("\n").includes("tinyfake"));
  assert.equal(output.at(-1), "build completed");
  assert.notEqual(state.rest, true);
});

test("escaped syntax respects incoming header, array, list, fence, indent, and quote contexts", () => {
  const cases = [
    { before: ["password:"], value: String.raw`\x22` },
    { before: ["password: ["], value: String.raw`\x5b` },
    { before: ['{"password":'], value: String.raw`[\x5b` },
    { before: ["credentials:", "- first"], value: String.raw`\x2d tinyfake` },
    { before: ["password: |", "  first"], value: String.raw`\x20\x20tinyfake` },
    { before: ["password:", "```"], value: String.raw`\x60\x60\x60` },
    { before: ['password: "'], value: String.raw`\x22\x5b` },
  ];
  for (const { before, value } of cases) {
    const state = { inKey: false };
    redactLines(before, state);
    redactLines([value], state);
    redactLines(["],", ...Array(35).fill("# padding")], state);
    assert.deepEqual(redactLines(["tinyfake", "]"], state), ["[redacted]", "[redacted]"]);
    assert.equal(state.rest, true);
  }
});

test("unrelated hyphens cannot turn secret-name prose into flags", () => {
  const diagnostics = [
    { trace: Array(9).fill("session closed - normal").join("\n") },
    { unit: "ms-per-stage", trace: Array(9).fill("session closed").join("\n") },
    { trace: Array(9).fill("session closed in work-tree").join("\n") },
  ];
  for (const diagnostic of diagnostics) {
    const state = { inKey: false };
    redactLines([JSON.stringify(diagnostic)], state);
    assert.notEqual(state.rest, true);
    assert.deepEqual(redactLines(["build completed"], state), ["build completed"]);
  }
  for (const diagnostic of diagnostics.slice(0, 2)) {
    const text = JSON.stringify(diagnostic);
    assert.equal(redactLine(text), text);
  }
  for (const flag of [String.raw`-\nsession tinyfake`, String.raw`--prefix.sess\nion tinyfake`, String.raw`-project_sess\nion tinyfake`]) {
    const state = { inKey: false };
    redactLines([String.raw`ordinary step\n`.repeat(9) + " " + flag], state);
    assert.equal(state.rest, true);
  }
});

test("raw quoting and alphanumeric escapes preserve structure, ambiguous escaped quotes do not", () => {
  for (const item of ['"x]y",', String.raw`"fi\x78ture",`]) {
    const state = { inKey: false };
    redactLines(["password: [", item], state);
    assert.notEqual(state.rest, true);
    redactLines(["]", ...Array(30).fill("padding")], state);
    assert.deepEqual(redactLines(["build completed"], state), ["build completed"]);
  }
  for (const item of [String.raw`\x22`, String.raw`"x]\"`, String.raw`"\x5b",`, String.raw`"\\x5b",`, String.raw`"x]\"y",`, String.raw`"x]\"y", junk`]) {
    const state = { inKey: false };
    redactLines(["password: [", item], state);
    assert.equal(state.rest, true);
  }
});

test("an alternate quote reading protects later credentials beyond the raw JSON close", () => {
  const state = { inKey: false };
  const output = redactLines(['{"credentials": [', String.raw`"x]\"y",`, '"hunter2"', "]}", ...Array(35).fill("# padding"), "tinyfake-after-raw-close"], state);
  assert.equal(state.rest, true);
  assert.ok(!output.join("\n").includes("tinyfake-after-raw-close"));
  assert.equal(output.at(-1), "[redacted]");
});

test("context certificates reject hidden JSON headers and incoming quoted readings", () => {
  const state = { inKey: false };
  const hidden = '{"trace":"' + String.raw`pa\nssword: tinyfake `.repeat(9) + '"}';
  redactLines(["password: [", hidden], state);
  assert.equal(state.rest, true);
  const quoted = { inKey: false };
  redactLines(['password: "', JSON.stringify({ trace: Array(9).fill("ordinary step").join("\n") })], quoted);
  assert.equal(quoted.rest, true);
});

test("escaped separators cannot expose the value beyond the raw masked word", () => {
  for (const separator of [String.raw`\t`, String.raw`\n`, String.raw`\r`, String.raw`\f`, String.raw`\v`, String.raw`\x20`, String.raw`\u0020`, String.raw`\040`, String.raw`\\t`]) {
    for (const prefix of ["password:", "password=", "--password "]) {
      const input = `${prefix}${separator} tinyfake`;
      // After `:` an unquoted value is every word to the line's end, so an escape that does not open a header cannot
      // move its end.
      assert.ok(["[redacted]", ...(prefix === "password:" ? ["password:[redacted]"] : [])].includes(redactLine(input)), input);
      assert.ok(!redactLines([input], { inKey: false }).join("\n").includes("tinyfake"), input);
    }
  }
  assert.equal(redactLine(String.raw`password: "fake\tvalue" trailing diagnostic`), 'password: "[redacted]" trailing diagnostic');
});

test("quoted flag mentions do not permanently silence a diagnostic stream", () => {
  for (const name of ["session", "password", "auth", "client-key"]) {
    const trace = JSON.stringify({ trace: Array(9).fill(`unknown option '--${name}'`).join("\n") });
    const state = { inKey: false };
    redactLines([trace], state);
    assert.notEqual(state.rest, true, name);
    assert.deepEqual(redactLines(["build completed"], state), ["build completed"]);
  }
});

test("pending continuations use a temporary protected hold without losing existing holds", () => {
  const state = { inKey: false };
  assert.deepEqual(redactLines(["ordinary \\"], state), []);
  assert.equal(state.hold, 1);
  assert.deepEqual(redactLines(["diagnostic", "build completed"], state), ["ordinary diagnostic", "build completed"]);
  assert.equal(state.hold, 0);
  const protectedState = { inKey: false, hold: 5 };
  redactLines(["ordinary \\"], protectedState);
  assert.equal(protectedState.hold, 5);
  assert.deepEqual(redactLines(["diagnostic"], protectedState), ["[redacted]"]);
  assert.equal(protectedState.hold, 4);
});

test("decoded physical headers protect list and block values before display flattening", () => {
  const separators = [String.raw`\n`, String.raw`\r`, String.raw`\v`, String.raw`\f`, String.raw`\u0085`, String.raw`\u2028`, String.raw`\u2029`, String.raw`\x0a`, String.raw`\012`, String.raw`\\n`, String.raw`\x5cn`, String.raw`\\u000a`];
  for (const separator of separators) {
    for (const input of [
      `password:${separator}- tinyfake`,
      `password:${separator}  - tinyfake`,
      `password: |${separator}  tinyfake`,
      `password: >${separator}  tinyfake`,
      `password: # comment${separator}- tinyfake`,
      `ordinary${separator}password:${separator}- tinyfake`,
    ]) {
      assert.equal(redactLine(input), "[redacted]", input);
      const state = { inKey: false };
      assert.deepEqual(redactLines([input], state), ["[redacted]"], input);
      assert.equal(state.rest, true, input);
      assert.deepEqual(redactLines(["- nextfake", "  nextfake", "later"], state), ["[redacted]", "[redacted]", "[redacted]"], input);
    }
  }
});

test("decoded newlines inside an already masked scalar preserve surgical output", () => {
  for (const input of [String.raw`password: "fake\nvalue"`, String.raw`password: "fake\rvalue"`]) {
    const state = { inKey: false };
    assert.deepEqual(redactLines([input], state), ['password: "[redacted]"']);
    assert.notEqual(state.rest, true);
    redactLines(Array(30).fill("padding"), state);
    assert.deepEqual(redactLines(["build completed"], state), ["build completed"]);
  }
});

test("decoded physical lines cannot clear incoming secret blocks or collections", () => {
  const separators = [String.raw`\n`, String.raw`\r`, String.raw`\v`, String.raw`\f`, String.raw`\u0085`, String.raw`\u2028`, String.raw`\u2029`, String.raw`\r\n`, String.raw`\x0a`, String.raw`\012`, String.raw`\\u2028`];
  for (const before of [
    ["password: |", "  first"],
    ["password: >", "  first"],
    ["password:", "  first"],
    ["password: [", "  first"],
    ["password: {", "  first"],
  ]) {
    for (const separator of separators) {
      const state = { inKey: false };
      redactLines(before, state);
      // Exhaust the finite fallback hold so collection checks rely on parser
      // state, not merely the first 30 lines after an unmatched opener.
      redactLines(Array(30).fill("  padding"), state);
      const out = redactLines([`${separator}  tinyfake`], state);
      out.push(...redactLines(["  laterfake"], state));
      assert.ok(!out.join("\n").includes("tinyfake"), `${before[0]} ${separator}`);
      assert.ok(!out.join("\n").includes("laterfake"), `${before[0]} ${separator}`);
      if (!before[0].endsWith("[") && !before[0].endsWith("{")) assert.equal(state.rest, true, separator);
    }
  }
});

test("closed JSON control diagnostics retain the existing context certificate", () => {
  for (const before of [["password: |", "  first"], ["password: [", "  first"]]) {
    const state = { inKey: false };
    redactLines(before, state);
    const trace = JSON.stringify({ trace: Array(9).fill("ordinary step").join("\n") });
    redactLines([trace], state);
    assert.notEqual(state.rest, true);
    redactLines(["]", ...Array(30).fill("padding")], state);
    assert.deepEqual(redactLines(["build completed"], state), ["build completed"]);
  }
});

test("partially decoded escape headers retain raw spellings across layers and batches", () => {
  const headers = [
    "\\u\\x30\\x30\\x37\\x34oken:",
    "\\u\\x30\\060\\x37\\064oken:",
    "\\u{\\x37\\x34}oken:",
    "\\x\\u0037\\u0034oken:",
    "\\\\u\\x30\\x30\\x37\\x34oken:",
    "token\\x3\\x61",
  ];
  for (const header of headers) {
    assert.equal(redactLine(header), "[redacted]", header);
    for (const options of [{}, { rest: true }]) {
      const state = { inKey: false };
      assert.deepEqual(redactLines([header], state, "/synthetic", options), ["[redacted]"], header);
      assert.equal(state.rest, true, header);
      assert.deepEqual(redactLines(["tinyfake", "laterfake"], { ...state }, "/synthetic", options), ["[redacted]", "[redacted]"], header);
    }
  }
});

test("a run of YAML anchor or tag marks after a secret's name has one reading: no exponential backtracking", () => {
  for (const line of [`api_key: ${"!".repeat(60)} x\\n`, `api_key: ${"&".repeat(60)} x`, `password = ${"!&".repeat(40)} y\\n`, `password: ${"!:".repeat(32_768)}`]) {
    const started = cpuMs();
    redactLine(line);
    redactLines([line, "  next"]);
    assert.ok(cpuMs() - started < 200, `${line.slice(0, 20)}… took too long`);
  }
  // Anchors and tags still introduce a value on the lines under them, a block scalar's included.
  assert.deepEqual(redactLines(["password: &anchor !!str |", "  hunter2"]).join("\n").includes("hunter2"), false);
  assert.deepEqual(redactLines(["password: !tag >-", "  'hunter2", "  more'"]).join("\n").includes("hunter2"), false);
});

test("a token split by any invisible character, or written in compatibility forms, is redacted", async () => {
  const { redactDeep, redactKeepingLines, shapeText } = await import("../lib/redact-cut.mjs");
  // What a reader sees: invisible characters show nothing and compatibility forms read as their plain letters.
  const seen = (text) => text.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");
  const fullwidth = (text) => text.replace(/[!-~]/g, (c) => String.fromCodePoint(c.codePointAt(0) + 0xfee0));
  const split = (unit) => `${TOKEN.slice(0, 8)}${unit}${TOKEN.slice(8)}`;
  const tokens = [
    ...["­", "‎", "‮", "⁡", "⁦", "᠎", "️", "\u{e0020}", "͏", "ㅤ"].map(split),
    fullwidth(TOKEN),
    `${fullwidth(TOKEN.slice(0, 4))}${TOKEN.slice(4)}`,
    `\u{1d420}${TOKEN.slice(1)}`,
  ];
  for (const token of tokens) {
    const line = `build used ${token} today`;
    const readings = {
      redactLine: redactLine(line),
      redactLines: redactLines([line]).join("\n"),
      shapeText: shapeText(line, 500),
      redactKeepingLines: redactKeepingLines(line),
      redactDeep: redactDeep({ text: line }).text,
    };
    for (const [name, out] of Object.entries(readings)) assert.ok(!seen(out).includes(TOKEN.slice(0, 6)), `${name}: ${JSON.stringify(out)}`);
  }
});

test("the ellipsis a cut writes is kept as it is, so shaping twice changes nothing", async () => {
  const { shapeText } = await import("../lib/redact-cut.mjs");
  const once = shapeText(`${"word ".repeat(40)}and ﬁnal`, 60);
  assert.equal(shapeText(once, 60), once);
  assert.equal(shapeText("one… two", 60), "one… two");
});

test("the folded reading only adds to what the written one hides: a no-break space, a styled letter or a fullwidth backslash keeps the value hidden", async () => {
  const { shapeText } = await import("../lib/redact-cut.mjs");
  for (const line of ["PASSWORD=first qzvtkfake", "ｘBearer qzvtkfake", "pass＼u0077ord: qzvtkfake", "token ＝ qzvtkfake"]) {
    for (const out of [redactLine(line), redactLines([line]).join("\n"), shapeText(line, 500)]) {
      assert.ok(!out.normalize("NFKC").includes("qzvtkfake"), `${JSON.stringify(line)} -> ${JSON.stringify(out)}`);
    }
  }
});

test("an invisible character before a name, a marked fullwidth key, a fullwidth continuation or an escaped look-alike keeps the value hidden", async () => {
  const { redactKeepingLines, shapeText } = await import("../lib/redact-cut.mjs");
  const hidden = (out) => !out.normalize("NFKC").includes("qzvtkfake");
  for (const line of ["x­Bearer qzvtkfake", "x​Bearer qzvtkfake", String.raw`ｐassword: qzvtkfake`]) {
    assert.ok(hidden(redactLine(line)), `redactLine ${JSON.stringify(line)}`);
    assert.ok(hidden(shapeText(line, 500)), `shapeText ${JSON.stringify(line)}`);
  }
  for (const text of ["**ｐａｓｓｗｏｒｄ**:\nqzvtkfake", "**ｐassword**:\n  qzvtkfake", "PASS＼\nWORD=qzvtkfake"]) {
    assert.ok(hidden(redactLines(text.split("\n")).join("\n")), `redactLines ${JSON.stringify(text)}`);
    assert.ok(hidden(redactKeepingLines(text)), `redactKeepingLines ${JSON.stringify(text)}`);
  }
  // Plain text with accents is kept; a form that folds to ASCII (`™`, `ﬁ`, `²`) may be read more ways than the readings
  // cover, so its line goes whole.
  assert.equal(redactLine("café — naïve done"), "café — naïve done");
  assert.equal(redactLine("café ™ ﬁle and m² done"), "[redacted]");
});

test("a fraction or a superscript digit in a word of numbers reads one way: prose keeps its lines, secrets still go", async () => {
  const { redactText } = await import("../lib/redact.mjs");
  const prose = ["about 2½ minutes", "3 × 4 is 12", "½ cup, ⅓ off, 10² km", "café — naïve done", "\"oui\" she said"];
  for (const line of prose) {
    assert.equal(redactLine(line), line);
    assert.equal(redactText(line, 10000), line);
  }
  // The ask that lost its whole card: no line after the fraction goes either.
  const card = "Run the build\nit takes about 2½ minutes\nthen check the phone";
  assert.deepEqual(redactLines(card.split("\n"), { inKey: false }, undefined, { rest: true }), card.split("\n"));
  // A fold beside a letter, a backslash or an invisible character, or in a long word, still holds the line.
  // A U+FEFF is a blank to `\s` but a reading takes it out (`Bearer\uFEFF⑩…` joins to a value), and a continued line
  // joins its word to the next line's (`AKIA…\` then `⑩⑩`).
  for (const line of ["m² done", "x²y", "\\1²³", "2\u200b½", "1234567890123456²", "Bearer\uFEFF⑩\uFEFF⑩\uFEFF⑩\uFEFF⑩", ["AK", "IA"].join("") + "ABCDEFGHIJKLMN\\\n⑩⑩", "203.0.113.¹", "::¹", "¹::", "Bearer 123456" + String.fromCharCode(0xd835, 92, 10, 0xdfce, 0xb2), String.fromCharCode(0xd835, 92, 10, 0xdc29) + "assword: qzvtkfake ½"]) {
    assert.equal(redactLine(line), "[redacted]", JSON.stringify(line));
  }
  // A line break ends a word: a fraction at the start of a line is not read with the word before it.
  assert.equal(redactText("Estimated time:\n2½ minutes\nDone", 10000), "Estimated time: / 2½ minutes / Done");
  assert.equal(redactText("about 2½\nminutes, 2½.", 10000), "about 2½ / minutes, 2½.");
  const { redactCutTop } = await import("../lib/redact.mjs");
  for (const ip of ["203.0.113.¹", "¹::"]) assert.ok(!redactCutTop([ip], undefined, {}, 0).join("\n").includes(ip));
  // Secrets on a line with a fraction are redacted as before; after a named one, the rest of the message goes too.
  const hidden = (out) => !String(out).includes("qzvtkfake") && !String(out).includes(TOKEN.slice(4));
  for (const line of [`PASSWORD=qzvtkfake for 2½ minutes`, `${TOKEN} ½`, "Bearer qzvtkfake12345 ½", "\\u0070assword: qzvtkfake ½"]) {
    assert.ok(hidden(redactLine(line)), `redactLine ${JSON.stringify(line)}`);
    const named = /assword/i.test(line);
    assert.ok(hidden(redactText(named ? `${line}\nqzvtkfake` : line, 10000)), `redactText ${JSON.stringify(line)}`);
  }
  const key = ["took 2½ minutes", ["-----BEGIN", "PRIVATE KEY-----"].join(" "), "qzvtkfake", ["-----END", "PRIVATE KEY-----"].join(" ")];
  assert.ok(hidden(redactLines(key, { inKey: false }).join("\n")));
  // A name in a compatibility-folded letter, escaped or written, beside a fraction: the value and the line after it go.
  for (const text of ["\\uFF50assword: qzvtkfake ½", "ｐassword: qzvtkfake 2½", "\\uFF50assword: 2½\nqzvtkfake", "ＰＡＳＳＷＯＲＤ=qzvtkfake ½", "\\u0070assword²: qzvtkfake"]) {
    assert.ok(hidden(redactText(text, 10000)), `redactText ${JSON.stringify(text)}`);
    assert.ok(hidden(redactLines(text.split("\n"), { inKey: false }, undefined, { rest: true }).join("\n")), `redactLines ${JSON.stringify(text)}`);
  }
});

test("an invisible character before a name keeps the value hidden in a card body, a continued line and across reads", async () => {
  const { redactDeep, redactEachLine, redactKeepingLines, shapeText } = await import("../lib/redact-cut.mjs");
  const hidden = (out) => !String(out).normalize("NFKC").includes("qzvtkfake");
  const line = "x­Bearer qzvtkfake";
  for (const [name, out] of Object.entries({
    redactKeepingLines: redactKeepingLines(line),
    redactEachLine: redactEachLine(line, 4096),
    shapeText: shapeText(line, 500),
    redactDeep: redactDeep({ text: line }).text,
    continued: redactLines(["prefix\\", line]).join("\n"),
    "value continued": redactLines(["x­Bearer \\", "qzvtkfake"]).join("\n"),
  })) assert.ok(hidden(out), `${name}: ${JSON.stringify(out)}`);
  const state = { inKey: false };
  const read = [...redactLines([`${line}\\`], state), ...redactLines([" done"], state)];
  assert.ok(hidden(read.join("\n")), JSON.stringify(read));
});

test("an escaped look-alike that opens a secret's name holds the stream, so its value on the next line stays hidden", () => {
  const state = { inKey: false };
  const read = [...redactLines(["\\uFF50assword:"], state), ...redactLines(["qzvtkfake"], state)];
  assert.ok(!read.join("\n").includes("qzvtkfake"), JSON.stringify(read));
  const once = redactLines(["\\uFF50assword:", "qzvtkfake"], { inKey: false }, undefined, { rest: true });
  assert.ok(!once.join("\n").includes("qzvtkfake"), JSON.stringify(once));
});

test("a name both split by an invisible character and written in compatibility forms keeps the value hidden", () => {
  for (const line of ["x­Ｂearer qzvtkfake", "x­Ｂｅａｒｅｒ qzvtkfake"]) {
    const out = redactLine(line);
    assert.ok(!out.normalize("NFKC").includes("qzvtkfake"), `${JSON.stringify(line)} -> ${JSON.stringify(out)}`);
  }
});

test("a name split by invisible characters in more than one way takes its line, and the value after it, out", async () => {
  const { shapeText } = await import("../lib/redact-cut.mjs");
  const hidden = (out) => !String(out).normalize("NFKC").includes("qzvtkfake");
  for (const line of ["x­Bea​rer qzvtkfake", "x­Bea­rer qzvtkfake"]) {
    assert.equal(redactLine(line), "[redacted]");
    assert.deepEqual(redactLines([line]), ["[redacted]"]);
    assert.ok(hidden(shapeText(line, 500)), line);
  }
  const state = { inKey: false };
  const read = [...redactLines(["x­pass​word:"], state), ...redactLines(["qzvtkfake"], state)];
  assert.ok(hidden(read.join("\n")), JSON.stringify(read));
  for (const line of ["family 👨‍👩‍👧 done", "می‌شود done", "press 1️⃣ now", "I ❤️ a build"])
    assert.deepEqual(redactLines([line]), [line]);
});

test("a bidi control before a secret's name stays in until the redactor has read it", async () => {
  const { redactDeep, redactEachLine, redactKeepingLines, shapeText } = await import("../lib/redact-cut.mjs");
  const hidden = (out) => !String(out).normalize("NFKC").includes("qzvtkfake");
  const line = "x‎Bearer qzvtkfake";
  for (const [name, out] of Object.entries({
    redactLine: redactLine(line),
    redactKeepingLines: redactKeepingLines(line),
    redactEachLine: redactEachLine(line, 4096),
    shapeText: shapeText(line, 500),
    redactDeep: redactDeep({ text: line }).text,
  })) assert.ok(hidden(out), `${name}: ${JSON.stringify(out)}`);
});

test("a key block opened with a no-break space ends at its END line for a caller that copies the state back", () => {
  const saved = { inKey: false };
  const out = [];
  for (const line of ["-----BEGIN RSA\u00a0PRIVATE KEY-----", "qzvtkfake", "-----END RSA PRIVATE KEY-----", "build completed"]) {
    const next = { ...saved };
    out.push(...redactLines([line], next));
    Object.assign(saved, next);
  }
  assert.ok(!out.join("\n").includes("qzvtkfake"), JSON.stringify(out));
  assert.equal(out.at(-1), "build completed");
});

test("an escaped surrogate pair that folds to a secret's name holds the stream", () => {
  const state = { inKey: false };
  const read = [...redactLines(["\\uD835\\uDC29assword:"], state), ...redactLines(["qzvtkfake"], state)];
  assert.ok(!read.join("\n").includes("qzvtkfake"), JSON.stringify(read));
  // An escaped emoji's pair folds to nothing else, so a log with one keeps showing.
  const log = { inKey: false };
  const emoji = '{"msg":"hi \\ud83d\\ude00"}';
  assert.deepEqual([...redactLines([emoji], log), ...redactLines(["build ok"], log)], [emoji, "build ok"]);
});

test("a line hidden for a word split more than one way holds the stream, so a value after it stays hidden", async () => {
  const { redactKeepingLines } = await import("../lib/redact-cut.mjs");
  const out = redactKeepingLines("x\u00AD--p\u200Bassword \"\nqzvtkfake\n\"");
  assert.ok(!String(out).normalize("NFKC").includes("qzvtkfake"), JSON.stringify(out));
});

test("an invisible character between ASCII punctuation and a word splits it too", async () => {
  const { shapeText } = await import("../lib/redact-cut.mjs");
  const payload = "correcthorse".repeat(3);
  for (const line of [`x_\u00ADghp_\u200B${payload}`, "x -\u200B-password qzvtkfake"]) {
    const out = shapeText(line, 500).normalize("NFKC");
    assert.ok(!out.includes(payload) && !out.includes("qzvtkfake"), `${JSON.stringify(line)} -> ${JSON.stringify(out)}`);
  }
});

test("compatibility forms that fold to ASCII hide their line and hold the stream, however they combine", async () => {
  const { shapeText, redactKeepingLines } = await import("../lib/redact-cut.mjs");
  const line = "hello\u2122Bearer \u24D0qzvtkfake";
  for (const out of [redactLine(line), redactLines([line]).join("\n"), shapeText(line, 500), shapeText("DB_P\u212BSS: qzvtkfake", 500)]) {
    assert.ok(!out.normalize("NFKD").includes("qzvtkfake"), JSON.stringify(out));
  }
  for (const opener of ['\u2122--\uFB05\u200Bpassword "', '\u2122\u00AD--connection_\u200B\uFB06ring "', '\uFB00\u00AD--pr\u2173\u200Bate-key "']) {
    const state = { inKey: false };
    const read = [...redactLines([opener], state), ...redactLines(["qzvtkfake"], state)];
    const kept = redactKeepingLines([opener, "qzvtkfake", '"'].join("\n"));
    assert.ok(!`${read.join("\n")}\n${kept}`.includes("qzvtkfake"), JSON.stringify(opener));
  }
  // An accented letter, a no-break space, an emoji and a cut's "…" fold to nothing a check reads another way.
  const text = "caf\u00e9 \u2014 na\u00efve \u201cquoted\u201d \u2764\ufe0f 1\ufe0f\u20e3 a\u00a0b done\u2026";
  const log = { inKey: false };
  assert.deepEqual([...redactLines([text], log), ...redactLines(["build ok"], log)], [text, "build ok"]);
});

test("an escape sequence between invisible characters and a word does not shield the word", () => {
  const out = redactLine("x\u00ad\x1b[0mBea\u200b\x1b[0mrer qzvtkfake");
  assert.ok(!out.includes("qzvtkfake"), JSON.stringify(out));
});

test("a cut long line and a home path keep what hides a value", async () => {
  const { redactEachLine } = await import("../lib/redact-cut.mjs");
  const cut = redactEachLine(`x\u00adBearer qzvtkfake ${"pad ".repeat(100)}`, 64);
  assert.ok(!cut.includes("qzvtkfake"), JSON.stringify(cut));
  for (const quote of ['"', "\uFF02", "\u200b"]) {
    const out = redactLines([`/home/alice${quote}password: qzvtkfake`], { inKey: false }).join("\n");
    assert.ok(!out.normalize("NFKC").includes("qzvtkfake"), JSON.stringify(out));
  }
});

test("a home path shortens only up to a path's next folder, so a label after the name is read", () => {
  for (const line of ["/home/password=qzvtkfake", "/home/Bearer qzvtkfake"]) assert.ok(!redactLine(line, "").includes("qzvtkfake"), line);
  assert.equal(redactLine(`${USERS}\u00e9lise/docs`, "/synthetic"), "~/docs");
});

test("half an escaped surrogate pair with a control or an escape sequence before its other half holds the stream", () => {
  for (const header of ["\\uD835\\x00\\uDC29assword:", "\\uD835\\e[0m\\uDC29assword:", "\\uD835\\x1b[0m\\uDC29assword:", "\\uD835\\n\\uDC29assword:"]) {
    const state = { inKey: false };
    const read = [...redactLines([header], state), ...redactLines(["qzvtkfake"], state)];
    assert.ok(!read.join("\n").includes("qzvtkfake"), JSON.stringify(read));
  }
});


test("a home folder at the end of a line is shortened too", () => {
  assert.equal(redactLine(`${USERS}elise`, "/synthetic"), "~");
  assert.equal(redactLine(`${USERS}elise/docs`, "/synthetic"), "~/docs");
});

test("an escaped line break between surrogate halves keeps a card body's value hidden", async () => {
  const { redactKeepingLines } = await import("../lib/redact-cut.mjs");
  const out = redactKeepingLines("\\uD835\\n\\uDC29assword:\nqzvtkfake");
  assert.ok(!out.includes("qzvtkfake"), out);
});

test("a home folder is shortened before / or the end, and read as written before a label", () => {
  assert.equal(redactLine("/home/alice/docs", "/synthetic"), "~/docs");
  assert.equal(redactLine("/home/compassion/docs", "/synthetic"), "~/docs");
  assert.equal(redactLine(`${USERS}author`, "/synthetic"), "~");
  for (const line of ["/home/password=qzvtkfake", "/home/Bearer qzvtkfakeqzvtkfake", `x ${USERS}db_token: qzvtkfake`, "/home/api**key**=qzvtkfake"])
    assert.ok(!redactLine(line, "/synthetic").includes("qzvtkfake"), line);
});

test("many escaped surrogate halves with no other half are read in linear time", () => {
  const line = "\\uD800 ".repeat(8192);
  const started = cpuMs();
  redactLine(line, "/synthetic");
  assert.ok(cpuMs() - started < 1000, "took too long");
});

test("a value opened past an invisible character and a no-break space stays held in a log", () => {
  const out = redactLines(["--password​ first \"", ...Array(31).fill("padding"), "qzvtkfake"], { inKey: false }, "/synthetic");
  assert.ok(!out.includes("qzvtkfake"));
});

test("readings are compared line by line as written, not by what each one shows", () => {
  // Built at run time, so the secret scan does not take the source for a key.
  const key = "PRIVATE KEY-----";
  const lines = [
    `-----BEGIN RSA ${key}`, `-----END RSA\u00a0${key}`, "[redacted]", "qzvtkfake", `-----END RSA ${key}`,
    `-----BEGIN \u200bRSA ${key}`, "qzvtkfake", "padding", `-----END RSA ${key}`,
  ];
  assert.ok(!redactLines(lines, { inKey: false }, "/synthetic").includes("qzvtkfake"));
});

test("a direction mark holds the line, and a label with … is read as one with ...", async () => {
  const { shapeText } = await import("../lib/redact-cut.mjs");
  assert.ok(!shapeText("‮drowssap ‬: qzvtkfake", 500).includes("qzvtkfake"));
  const state = { inKey: false };
  redactLines(["password…:"], state, "/synthetic");
  assert.ok(!redactLines(["qzvtkfake"], state, "/synthetic").includes("qzvtkfake"));
  const cut = shapeText("hello world ".repeat(60), 100);
  assert.equal(shapeText(cut, 100), cut);
});

test("an invisible character before a label's ellipsis is read in every reading", async () => {
  const { redactKeepingLines } = await import("../lib/redact-cut.mjs");
  for (const header of ["password​…:", "password­…:"]) {
    const state = { inKey: false };
    redactLines([header], state, "/synthetic");
    assert.ok(!redactLines(["  qzvtkfake"], state, "/synthetic").join("\n").includes("qzvtkfake"), header);
    assert.ok(!redactKeepingLines(`${header}\n  qzvtkfake`).includes("qzvtkfake"), header);
  }
});

test("a line of many -u flags is read once: each -u's value test does not read its word to the end", () => {
  for (const line of [`-u${";-u".repeat(20_000)}`, `--user${";--user=".repeat(10_000)}`, `x -u${"-u".repeat(20_000)}`, `-u${" -u".repeat(20_000)}`,
    `curl ${"-u a:b ".repeat(16_000)}`, "-u a: ".repeat(16_000), `${"-u origin ".repeat(16_000)}TOKEN=x`, `${"-u;".repeat(16_000)}TOKEN=x`]) {
    const started = cpuMs();
    redactLine(line, "/synthetic");
    redactLines([line, "  next"], { inKey: false }, "/synthetic");
    redactLines([line], { inKey: false }, "/synthetic", { rest: true });
    assert.ok(cpuMs() - started < 300, `${line.slice(0, 20)}… took too long`);
  }
});

test("a -u value is still redacted after a long run of -u flags", () => {
  const run = "-u;".repeat(3000);
  for (const line of [`${run} curl -u admin:tinyfake`, `${run} curl -uadmin:tinyfake`, `${run} curl --user "admin:tinyfake"`]) {
    assert.equal(redactLine(line, "/synthetic", Infinity).includes("tinyfake"), false, line.slice(-40));
    assert.equal(redactLines([line], { inKey: false }, "/synthetic", { rest: true, max: Infinity }).join("\n").includes("tinyfake"), false);
  }
  assert.equal(redactLine(`${run} git push -u origin main`, "/synthetic", Infinity).endsWith("git push -u origin main"), true);
  // An escaped -u is a new flag even when a long -u run on the line matches the same text as written.
  assert.equal(redactLine(`curl -u${";-u".repeat(200)}x: \\x2du fakeuser:tinyfake`, "/synthetic"), "[redacted]");
  // A secret's value after a long -u word is still counted from its own `=`: its open quote holds the next line.
  assert.deepEqual(redactLines([`-u ${"a".repeat(300)}: " TOKEN="tinyfake`, "laterfake"], { inKey: false }, "/synthetic")[1], "[redacted]");
});

test("a long run of name characters is read once: a secret's name rule starts only at its first boundary", async () => {
  const { redactKeepingLines } = await import("../lib/redact-cut.mjs");
  // The issue's worst shape (`ab.` to 4,000 characters a line) and its siblings: on main 128 KB of `ab.` took over a
  // second, every later word boundary (or `--`) in a line rescanning it to its end.
  for (const unit of ["ab.", "ab-", "a--", "--a", "a_.", "a.-"]) {
    const line = unit.repeat(Math.ceil(4000 / unit.length)).slice(0, 4000);
    const text = Array(32).fill(line).join("\n");
    const started = cpuMs();
    redactKeepingLines(text);
    redactLines(text.split("\n"), { inKey: false }, "/synthetic", { rest: true, max: Infinity });
    assert.ok(cpuMs() - started < 600, `${unit} took too long`);
  }
});

test("a secret's name later in a long run, or after dots, dashes and `--`, still has its value redacted", () => {
  for (const line of [`${"ab.".repeat(2000)}PASSWORD=tinyfake`, `${"ab-".repeat(2000)}token: "tinyfake"`, "x.y.api_key: tinyfake horse", "-.SECRET=tinyfake",
    "ab--x--PASSWORD tinyfake", `${"a--".repeat(2000)}--TOKEN=tinyfake`, "a---token tinyfake", `"ab.SECRET": "tinyfake"`]) {
    assert.equal(redactLine(line, "/synthetic", Infinity).includes("tinyfake"), false, line.slice(-40));
    assert.equal(redactLines([line], { inKey: false }, "/synthetic", { rest: true, max: Infinity }).join("\n").includes("tinyfake"), false, line.slice(-40));
  }
});
