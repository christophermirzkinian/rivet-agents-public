import assert from "node:assert/strict";
import test from "node:test";
import { coverLines, redactCutTop, redactLine, redactLines, redactText } from "../lib/redact.mjs";
import { redactKeepingLines } from "../lib/redact-cut.mjs";

// Telling a sentence from a key needs regex modifiers, which came in Node 23. Node 22 hides the sentence too, which is
// the safe way round, so these cases, which expect the sentence kept, run on Node 23 and later.
const hasModifiers = (() => {
  try {
    return Boolean(new RegExp("(?-i:a)", "i"));
  } catch {
    return false;
  }
})();
const proseCase = { skip: hasModifiers ? false : "needs regex modifiers (Node 23+): Node 22 hides the sentence as well" };

// Five forms that once passed redactLines unchanged. Synthetic secrets and documentation IPs only.
const HOME = "/synthetic";
const read = (/** @type {string[]} */ lines) => redactLines(lines, { inKey: false }, HOME);
const leaks = (/** @type {string[]} */ out, /** @type {string[]} */ secrets) => secrets.filter((secret) => out.join("\n").includes(secret));

test("a collection under a secret's key that closes on its own row goes", () => {
  for (const line of [
    'credentials: ["hunter2", "swordfish"]',
    "credentials: [hunter2, swordfish]",
    "  credentials: [hunter2, swordfish]  # rotated",
    '{"credentials": {"user": "ops", "pw": "hunter2"}, "swordfish": 1}',
    "PASSWORDS=[hunter2,swordfish]",
    "PASSWORDS=[hunter2, swordfish]",
    'passwords=["hunter2", "swordfish"]',
    '{"credentials": ["first #hunter2", "swordfish"]}',
    'credentials: ["first # hunter2", "swordfish"]',
    "api_key = { primary = 'hunter2', spare = 'swordfish' }",
  ]) {
    assert.deepEqual(leaks(read([line]), ["hunter2", "swordfish"]), [], line);
    assert.deepEqual(leaks([redactLine(line, HOME)], ["hunter2", "swordfish"]), [], line);
  }
  // The key stays: only its value goes.
  assert.deepEqual(read(["credentials: [hunter2, swordfish]"]), ["credentials: [redacted]"]);
});

test("an unquoted value of several words goes whole, not only its first word", () => {
  for (const line of [
    "password: correct horse battery staple",
    "Database password: correct horse battery staple",
    "password = correct horse battery staple",
    "password: correct horse battery staple # rotated",
    "  db_passphrase:   correct horse battery staple   ",
    "password: correct\u1680horse\u3000battery\u00a0staple",
    // An earlier rule's marker on the first word leaves the rest of the value to go too.
    `password: ${"ghp_" + "A".repeat(20)} horse battery staple`,
  ]) {
    assert.deepEqual(leaks(read([line]), ["horse", "battery", "staple"]), [], line);
    assert.deepEqual(leaks([redactLine(line, HOME)], ["horse", "battery", "staple"]), [], line);
  }
  assert.deepEqual(read(["password: correct horse battery staple", "next: fine"]), ["password: [redacted]", "next: fine"]);
  // A YAML comment after the value stays, and a shell assignment's value is still one word before its command.
  assert.deepEqual(read(["password: correct horse battery staple # rotated"]), ["password: [redacted] # rotated"]);
  assert.deepEqual(read(["GH_TOKEN=hunter2 gh pr list"]), ["GH_TOKEN=[redacted] gh pr list"]);
});

test("a URL with a password and no user name loses its password", () => {
  for (const line of ["redis://:hunter2@cache.example/0", "REDIS_URL=rediss://:hunter2@cache.example:6380", "connect amqp://:hunter2@mq.example"]) {
    assert.deepEqual(leaks(read([line]), ["hunter2"]), [], line);
    assert.deepEqual(leaks([redactLine(line, HOME)], ["hunter2"]), [], line);
  }
  assert.deepEqual(read(["redis://:hunter2@cache.example/0"]), ["redis://[redacted]@cache.example/0"]);
  // A host with no credentials is untouched.
  assert.deepEqual(read(["redis://cache.example:6379/0"]), ["redis://cache.example:6379/0"]);
});

test("a secret's name inside a URL's password does not leave the password while a value is open", () => {
  // The line is cut at the start of the URL the name is in, whatever its scheme or slashes.
  assert.deepEqual(read(["https://u:hunter2TOKEN=foo@host TOKEN=[", "next"]), ["[redacted]", "[redacted]"]);
  assert.deepEqual(read(["see redis://:hunter2TOKEN=x@h TOKEN=[", "next"]), ["see [redacted]", "[redacted]"]);
  assert.deepEqual(read(["https://u:hunter2;--token=x@h TOKEN=[", "next"]), ["[redacted]", "[redacted]"]);
  assert.deepEqual(read([String.raw`https:\/\/u:hunter2TOKEN=x@host TOKEN=[`, "next"]), ["[redacted]", "[redacted]"]);
  // The cut stays where the name was: what follows the URL is still the open value's.
  assert.deepEqual(read(["https://u:TOKEN=[@host hunter2", "next"]), ["[redacted]", "[redacted]"]);
  // An escaped `@`, or a URL with no `@` left after the cut, still reads as a URL.
  for (const line of [
    String.raw`https://u:hunter2TOKEN=x\x40host TOKEN=[`,
    "https://u:hunter2TOKEN=x%40host TOKEN=[",
    "https://u:hunter2TOKEN=[ x",
    String.raw`https:\U0000002f/u:hunter2TOKEN=x\U00000040host TOKEN=[`,
    "https:%252f%252fu:hunter2TOKEN=x%2540host TOKEN=[",
  ]) {
    assert.deepEqual(read([line, "next"]), ["[redacted]", "[redacted]"], line);
  }
  // A line the cut alone withholds whole is still withheld whole.
  assert.deepEqual(read([String.raw`otp=123456 https://u:Ab9Cd8\x37Zf7Gh6Jk9!TOKEN=x@h TOKEN=[`, "next"]), ["[redacted]", "[redacted]"]);
  // A URL before the name keeps its host, and one with no value open is as before.
  assert.deepEqual(read(["https://u:hunter2@host TOKEN=[", "next"]), ["https://[redacted]@host TOKEN= [redacted]", "[redacted]"]);
  assert.deepEqual(read(["https://u:hunter2TOKEN=foo@host", "next"]), ["https://[redacted]@host", "next"]);
  // The run around the cut is found in linear time on a long line.
  const cpuMs = () => {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1000;
  };
  let fastest = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const start = cpuMs();
    read(["a".repeat(80_000) + " https://u:hunter2TOKEN=x@h TOKEN=["]);
    fastest = Math.min(fastest, cpuMs() - start);
  }
  assert.ok(fastest < 300, `took ${Math.round(fastest)}ms`);
});

test("a command's password flag with an open quote covers the rows until it closes", () => {
  for (const [first, second] of [
    ['mysql -uroot -p"first', 'copper lake"'],
    ["mysqldump -u root -p'first", "copper lake'"],
    ['mariadb -h db.example -p"first', 'copper lake"'],
    // Assembled at run time, so the secret scanner reads no SSH password in the source: it is synthetic.
    ["ssh" + 'pass -p "first', 'copper lake" ssh ops@host.example'],
    ["redis-cli -h cache.example -a 'first", "copper lake'"],
    ['zip -r out.zip dir -P "first', 'copper lake"'],
    ["7z a out.7z dir -p'first", "copper lake'"],
    // Another command's name as an argument, and the other password-flag commands.
    ['mysql -h redis-cli -p"first', 'copper lake"'],
    ['redis-cli -h mysql -a "first', 'copper lake"'],
    ['mongosh -u ops -p"first', 'copper lake"'],
    ['ldapsearch -D cn=ops -w "first', 'copper lake"'],
    ['sqlcmd -S db.example -P "first', 'copper lake"'],
    // A quoted argument's `;` ends no command, and a flag inside quotes is not the command's.
    ['mysql -e "select 1;" -p"first', 'copper lake"'],
    ["echo 'mysql -p\"'; mysql -p'first", "copper lake'"],
    // A quoted or pathed command name is still the command.
    ['"mysql" -p"first', 'copper lake"'],
    ['/usr/bin/mysql -u ops -p"first', 'copper lake"'],
    ['mysql -e"select 1;" -p"first', 'copper lake"'],
    ['mysql -e"select $x;" -p"first', 'copper lake"'],
  ]) {
    // Past the hold an unbalanced secret value keeps (HOLD_LINES), the log shows again.
    const out = read([first, second, ...Array(40).fill("build completed")]);
    assert.deepEqual(leaks(out, ["first", "copper", "lake"]), [], first);
    assert.equal(out.at(-1), "build completed", first);
    assert.deepEqual(leaks([redactText(`${first}\n${second}`, 2000)], ["first", "copper", "lake"]), [], first);
  }
  // An escaped separator before the flag, for every command family, held as an escaped `mysql\t-p"` is, and a
  // command in backticks, held while its substitution stays open.
  for (const [first, second] of [
    ['echo `mysql -p"first', 'copper lake"`'],
    // A command in a double-quoted substitution still runs.
    ['echo -n"$(mysql -p"first', 'copper lake")"'],
    [String.raw`mongosh\t-p"first`, 'copper lake"'],
    [String.raw`ldapsearch\t-w "first`, 'copper lake"'],
    [String.raw`sqlcmd\t-P "first`, 'copper lake"'],
  ]) {
    assert.deepEqual(leaks(read([first, second, "build completed"]), ["first", "copper", "lake"]), [], first);
  }
  // The same flags on commands that take no password open nothing.
  assert.deepEqual(read(['mkdir -p "a', 'b"', "done"]), ['mkdir -p "a', 'b"', "done"]);
  assert.deepEqual(read(['git commit -a -m "subject', 'body"', "done"]), ['git commit -a -m "subject', 'body"', "done"]);
});

test("an IP address written with escapes is withheld, as its plain spelling is covered", () => {
  for (const line of [
    "allow 203\\.0\\.113\\.42 now",
    "allow 203\\x2e0\\x2e113\\x2e42 now",
    "allow \\x32\\x30\\x33.0.113.42 now",
    "allow 2001\\:db8\\:\\:42 now",
    "allow 203.0\\b.113.42 now",
    // The same address written plainly too shows no more of the escaped one.
    "allow 203.0.113.42 and 203\\.0\\.113\\.42 now",
  ]) {
    assert.equal(redactLine(line, HOME), "[redacted]", line);
    assert.deepEqual(read([line]), ["[redacted]"], line);
  }
  // Escapes that read as no address leave the line alone.
  assert.equal(redactLine("version 1\\.2 ready\\n", HOME), "version 1\\.2 ready\\n");
  assert.equal(redactLine("printf 'done\\n'", HOME), "printf 'done\\n'");
});

test("a long line of password flags or address-shaped escapes is read in linear time", () => {
  // CPU time, not the wall clock: a loaded runner stalls a run, a quadratic read costs the CPU it always did.
  const cpuMs = () => {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1000;
  };
  for (const line of ["mysql " + "-p ".repeat(8000), "mysql " + '-p"a '.repeat(3000), "mysql " + "-p$( ".repeat(4000), "mysql -h redis-cli " + "-a ".repeat(8000), "redis-cli " + "-a ".repeat(8000), "password: " + "ab ".repeat(10_000), "mysql -pfoo ".repeat(8000) + "-a ".repeat(8000), 'mysql "'.repeat(8000), "mysql " + '\\"'.repeat(8000), "mysql " + `'"`.repeat(8000)]) {
    let fastest = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = cpuMs();
      read([line, "next"]);
      fastest = Math.min(fastest, cpuMs() - start);
    }
    assert.ok(fastest < 150, `${line.slice(0, 20)}… took ${Math.round(fastest)}ms`);
  }
});

test("a line of many secrets' values or a long blank run is read in linear time, and still redacted", () => {
  const cpuMs = () => {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1000;
  };
  const lines = [
    ...["TOKEN=[".repeat(6000), 'TOKEN="'.repeat(6000), "TOKEN=`".repeat(6000), " --password=[".repeat(6000), "password: a" + " ".repeat(20_000) + "#", "a" + "\t".repeat(20_000) + "b"],
    // Values that close: each secret's regex read only its value's start, not the line's end.
    ...["TOKEN=x ".repeat(32_000), " --password=x".repeat(20_000), "token: x, ".repeat(25_000)],
    // Every flag's value has a line break in it (an escaped U+2028) but the last's, which each gives way to: kept once.
    "-pass x ".repeat(500) + "\\u2028 -pass " + "$( ".repeat(500),
  ];
  for (const line of lines) {
    let fastest = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = cpuMs();
      read([line, "next"]);
      redactLine(line, HOME);
      fastest = Math.min(fastest, cpuMs() - start);
    }
    assert.ok(fastest < 300, `${line.slice(0, 20)}… took ${Math.round(fastest)}ms`);
  }
  // Past the budget the line overflows: its values go and the log is held.
  assert.deepEqual(read(["TOKEN=[a".repeat(6000), "hunter2"]), ["TOKEN= [redacted]", "[redacted]"]);
  // Very many values, each kept once: never past V8's argument limit.
  assert.deepEqual(read(["TOKEN=[# ".repeat(100_000), "hunter2"]), ["TOKEN= [redacted]", "[redacted]"]);
  assert.equal(redactLine("password: hunter2" + " ".repeat(20_000) + "#", HOME), "password: [redacted]");
  // Values that close soon cost little: the line stays under the budget and the log goes on.
  const closed = ["TOKEN=x ".repeat(32_000), "--token=x;".repeat(300), "--user-token=x;".repeat(300), JSON.stringify(Array(3000).fill({ session: "closed" }))];
  for (const line of closed) {
    const state = { inKey: false };
    redactLines([line], state, HOME);
    assert.equal(redactLines(Array(40).fill("build completed"), state, HOME).at(-1), "build completed");
  }
});

// A message to the owner went out as 16 lines of markers: `pass` in a sentence read as a key, its list as the value.
const OFFER = [
  "What it has to pass: Sam's reviewers score each entry, and 6/9 is needed. We scored 5/9 and then 4.7/9. The reviewers' tags were:",
  "- Low quality assets",
  "- Poor animations",
  "- Poor tool bar",
  "Nothing was raised on the numbers or the code.",
  "Attached: the report",
].join("\n");

test("a secret word in a sentence starts no value, and nothing under it goes", proseCase, () => {
  assert.equal(redactKeepingLines(OFFER), OFFER);
  assert.deepEqual(read(OFFER.split("\n")), OFFER.split("\n"));
  for (const text of [
    "The pass mark is 6/9",
    "has to pass: anything",
    "What it has to pass:\n- Low quality\n- Poor tool bar\nDone",
    "the next session: tomorrow\nline two",
    "Two tokens: both spent\nline two",
    "Tests passed: 1200\nline two",
    "Passed: 12/12\nline two",
    "Author: someone\nline two",
  ]) assert.equal(redactKeepingLines(text), text);
});

test("a key at its line's start or an identifier still hides its value, and every shape still goes", proseCase, () => {
  const value = "hunter2";
  for (const line of [
    `password: ${value}`,
    `Token: ${value}`,
    `pass: ${value}`,
    `- token: ${value}`,
    `1. token: ${value}`,
    `export token: ${value}`,
    `{ token: ${value} }`,
    `bob, token: ${value}`,
    `user=bob token: ${value}`,
    `DB_PASSWORD=${value}`,
    `my api_key: ${value}`,
    `my api-key: ${value}`,
    `my apiKey: ${value}`,
    `my client.secret: ${value}`,
    `Database password: ${value}`,
    `curl -d token=${value} x`,
    `a token = ${value}`,
    `my pass:${value}`,
    `my pass: '${value}'`,
    `my token: [${value}]`,
  ]) assert.ok(!redactKeepingLines(line).includes(value), line);
  assert.equal(redactKeepingLines("password: correct horse battery"), "password: [redacted]");
  const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0", "K1l2M3n4O5p6Q7r8"].join("");
  assert.equal(redactKeepingLines(`my token: ${token}`), "my token: [redacted github token]");
  assert.equal(redactKeepingLines(`my token: ${"Zx8Qp2Lm7Rt4Vw9Ks3Nb"}`), "my token: [redacted]");
});

test("a list under a real key still goes, wherever the key stands", () => {
  for (const key of ["credentials:", "1. credentials:", "Database password:"]) {
    assert.deepEqual(read([key, "- one", "- two", "next: fine"]), [key, "[redacted]", "[redacted]", "next: fine"]);
  }
  const raw = ["exp", "ort credentials:", "- hunter2", "- swordfish"];
  assert.deepEqual(leaks(coverLines(read(raw), HOME, null, raw), ["hunter2", "swordfish"]), []);
});

test("a token wrapped under a prose word still goes, and a wrapped sentence stays", proseCase, () => {
  const head = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0", "K1l2M3n4"].join("");
  assert.ok(!redactKeepingLines(`my token: ${head}\nO5p6Q7r8`).includes("O5p6Q7r8"));
  assert.equal(redactKeepingLines("has to pass : anything\n- Low quality\nDone"), "has to pass : anything\n- Low quality\nDone");
  const rows = ["What it has to pa", "ss: anything", "- Low quality", "Done"];
  assert.deepEqual(redactCutTop(rows, HOME, { rest: true }, 0), rows);
  assert.ok(!redactCutTop(["my pass", "word: hunter2", "next"], HOME, { rest: true }, 0).join("\n").includes("hunter2"));
});

test("a line of many prose words is read in linear time", () => {
  const started = Date.now();
  redactKeepingLines("has to pass: x ".repeat(4000));
  redactKeepingLines(`${"a.".repeat(20000)}a pass: x`);
  assert.ok(Date.now() - started < 2000);
});

test("a camelCase name is an identifier, never a prose word", proseCase, () => {
  for (const text of ["export byPass=hunter2", "byPass: hunter2", "my webHook: hunter2", "the byPass: hunter2", "ByPass=hunter2", "my WebHook: hunter2", "my pAss: hunter2", "bYpass=hunter2", "my tOken: hunter2", "my PAss: hunter2", "the TOken: hunter2"]) {
    assert.ok(!redactKeepingLines(text).includes("hunter2"), text);
    assert.ok(!read([text]).join("\n").includes("hunter2"), text);
  }
  for (const text of ["Tests bypassed: 3\nThe webhook: tomorrow", "Tests PASSED: 12\nTwo Tokens: spent"]) assert.equal(redactKeepingLines(text), text);
});

test("a prose word's secret takes its wrapped end, escaped or past the line limit, and a marker in a sentence is no secret", proseCase, () => {
  const head = ["gh", "p_A1b2C3d4E5f6G7h8I9j0K1l2M3n4"];
  const message = { rest: true };
  const escaped = [`my to\\ken: ${head.join("\\")}`, "O5p6Q7r8"];
  assert.ok(!redactKeepingLines(escaped.join("\n")).includes("O5p6Q7r8"));
  const long = ["a ".repeat(260) + `my token: ${head.join("")}`, "O5p6Q7r8"];
  assert.ok(!redactLines(long, { inKey: false }, HOME, message).at(-1).includes("O5p6Q7r8"));
  // A rule that folds markers into one must not cover the marker a secret added.
  for (const covered of [`my token: ?key=[redacted][redacted] ${head.join("")}`, `my token: https://[redacted]:[redacted]@h ${head.join("")}`]) {
    assert.ok(!redactKeepingLines(`${covered}\nO5p6Q7r8`).includes("O5p6Q7r8"), covered);
  }
  assert.ok(!redactKeepingLines(`my token: ${"https://"}u:[redacted]front@\nhunter2@host.test`).includes("hunter2"));
  // Nor may taking a marker out take the token's head with it, or join it to the word before.
  for (const covered of [`my token: note [redacted ${head.join("")}`, `my token: prefix[redacted]${head[0]}p_SYNTHETICUPPERCASECREDENTIAL`, "my token: note [redacted qzvqzvqzvqzvqzvqzvqzv]", "my token: Bearer /home/Zx8Qp2Lm7Rt4Vw9Ks3Nb[redacted]suffix", "my token: /usr/bin/mysql[redacted]ump -pX"]) {
    assert.ok(!redactKeepingLines(`${covered}\nO5p6Q7r8`).includes("O5p6Q7r8"), covered);
  }
  // A marker's taking out writes no secret of its own: not by what it leaves, what it joins, or a blank in its place.
  for (const line of ["has to pass: ?key=[redacted-ip]", "has to pass: token[redacted]validation", "has to pass: token[redacted] validation", "has to pass: token[redacted-ip] validation", "has to pass: x [redacted", "has to pass: /home/someone/notes [redacted]", `has to pass: ${"https://"}[redacted]:[redacted]@h`, `has to pass: ${"https://"}:[redacted]@host.test`, "has to pass: ?key=[redacted api key]", "has to pass: mysql -p[redacted]"]) {
    assert.ok(redactKeepingLines(`${line}\n- Low quality\nDone`).endsWith("\n- Low quality\nDone"), line);
  }
  for (const text of [
    "has to pass: anything [redacted]\n- Low quality\nDone",
    "has to pass: no [redacted] placeholders\n- Low quality\nDone",
    "has to pass: ?key=[redacted]\n- Low quality\nDone",
  ]) assert.equal(redactKeepingLines(text), text);
});

test("a title ending in a chance word and a `:` keeps the bullets under it", proseCase, () => {
  const text = [
    "New times, all moved before they passed:",
    "- Billing page: 11pm → 1:30am. An engine change reached main, so its checks must be redone",
    "- Quiz page: 11pm → 2am. Same cause",
    "- Docs site stage B: being reworked",
  ].join("\n");
  assert.equal(redactKeepingLines(text), text);
  assert.deepEqual(read(text.split("\n")), text.split("\n"));
});

test("a prose word's line is read no further than any line, in time linear to it", () => {
  const started = performance.now();
  for (const word of ["mysql ", "redis-cli ", "zip "]) redactLines([`has to pass: x ${word.repeat(40000)}`], { inKey: false }, HOME, { rest: true });
  assert.ok(performance.now() - started < 3000);
});
