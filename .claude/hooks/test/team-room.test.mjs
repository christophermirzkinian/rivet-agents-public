import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACT } from "../../../bridge/test/redaction-corpus.mjs";
import { messagesOf, redactText, runnerSends } from "../team-room.mjs";

// The Team room hook fails closed by shape, not by a list of formats: every crafted line in the log redaction corpus
// is shown without its secret, alone and as one message.
test("no secret in the log redaction corpus reaches the Team room", () => {
  for (const { line, secret } of REDACT) {
    const out = redactText(line);
    for (const s of secret) assert.ok(!out.includes(s), `${JSON.stringify(line)} leaked ${s}: ${out}`);
  }
  // As one message, either way round: a secret is checked unless another line shows that word as plain text.
  const lines = REDACT.map(({ line }) => line);
  const secrets = REDACT.flatMap(({ secret }) => secret).filter((s) => REDACT.every(({ line, secret }) => secret.includes(s) || !line.includes(s)));
  assert.ok(secrets.length > 50);
  for (const message of [lines.join("\n"), [...lines].reverse().join("\n")]) {
    const out = redactText(message);
    for (const s of secrets) assert.ok(!out.includes(s), `the corpus as one message leaked ${s}: ${out}`);
    assert.ok(Array.from(out).length <= 600);
  }
});

test("an agent's report reads as written", () => {
  const report = "PR #42 merged 3f2a1b9c, deploy verified (marker team-room-on). Still at ~/shots/team-room/room-412.png, don't wait; it's 6:15pm.";
  assert.equal(redactText(report), report);
  assert.equal(redactText("Rebase on main, then `pnpm -s release:now rivet`"), "Rebase on main, then `pnpm -s ••• rivet`");
});

// A flag's value is never shown, whatever stands between them (YAML lists, commas, continuations) or however it is quoted.
test("no flag's value reaches the Team room", () => {
  const seps = [" ", " , ", " - ", "\n  - ", ",\n  ", " \\\n ", "\n", " : ", " -- ", " | ", " ; ", " [ ", " ( ", " => ", "\t", ", #####\n  "];
  const values = ["hunter2", "swordfish", "'correct horse battery staple'", '"correct horse battery staple"', "x'correct horse'y", "' @!?~ '"];
  let checked = 0;
  for (const flag of ["-a", "-p", "-u", "--user", "-k"]) {
    for (const sep of seps) {
      for (const value of values) {
        for (const before of ["", "args: [redis-cli, ", "- ", "`"]) {
          const out = redactText(`${before}cmd ${flag}${sep}${value} ping`);
          for (const word of ["hunter2", "swordfish", "horse", "battery", "@!?~"]) {
            if (!value.includes(word)) continue;
            checked++;
            assert.ok(!out.includes(word), `${JSON.stringify(before + flag + sep + value)} shows ${word}: ${out}`);
          }
        }
      }
    }
  }
  assert.ok(checked > 500);
});

test("a secret, or its name, in compatibility forms reaches the Team room no more than in plain letters", () => {
  const fullwidth = (text) => text.replace(/[!-~]/g, (c) => String.fromCodePoint(c.codePointAt(0) + 0xfee0));
  for (const text of [`db ${fullwidth("password")} is xqzrtkp`, `the key is ${fullwidth("xqzrtkp")}`]) {
    const out = redactText(text).normalize("NFKC");
    assert.ok(!out.includes("xqzrtkp"), out);
  }
});

test("a combining mark in a secret's name, or fullwidth quotes round its value, still keep the value out", () => {
  for (const text of ["db passwórd is canary7", "redis-cli -a ＂ canary7 ＂", "redis-cli -a ＂canary7＂ now"]) {
    const out = redactText(text).normalize("NFKC");
    assert.ok(!out.includes("canary7"), `${JSON.stringify(text)} -> ${out}`);
  }
});

test("a secret's name or flag the written reading masks but does not name still keeps the value out", () => {
  for (const text of ["db ⓟassword is canary7", "redis-cli －a canary7", "ｐａｓｓｗｏｒｄ： canary7"]) {
    const out = redactText(text).normalize("NFKC");
    assert.ok(!out.includes("canary7"), `${JSON.stringify(text)} -> ${out}`);
  }
  assert.equal(redactText("plain words and café"), "plain words and café");
});

test("a fullwidth letter and a combining accent in one secret's name still keep the value out", () => {
  for (const text of ["db ｐasswórd™ is canary7", "ｐasswórd99 is canary7"]) {
    const out = redactText(text).normalize("NFKC");
    assert.ok(!out.includes("canary7"), `${JSON.stringify(text)} -> ${out}`);
  }
});

test("a filler or other default-ignorable character inside a secret's name stops the line", () => {
  for (const text of ["passㅤword is canary7", "passᅟword is canary7", "redis-cli -͏a canary7"]) {
    const out = redactText(text).normalize("NFKC");
    assert.ok(!out.includes("canary7"), `${JSON.stringify(text)} -> ${out}`);
  }
  assert.ok(redactText("I ❤️ this").includes("this"));
});

test("a secret's label with a letter NFKC keeps apart (Å for A) still keeps the value out", () => {
  const out = redactText("DB_P\u212BSS canary7").normalize("NFKC");
  assert.ok(!out.includes("canary7"), out);
  assert.equal(redactText("I ❤️ this café"), "I ••• this café");
});

test("a symbol that folds to letters inside a secret's name stops the text", () => {
  for (const text of ["passw\u2122ord is canary7", "\u24dfass\u2122word is canary7"]) {
    const out = redactText(text).normalize("NFKC");
    assert.ok(!out.includes("canary7"), out);
  }
});

test("a home path's name before a label hides no value", () => {
  assert.ok(!redactText("/home/password=canary7").includes("canary7"));
  assert.ok(!String(redactText("/home/\uFF41pi**key**: meadow")).includes("meadow"));
  assert.ok(!String(redactText('cd "/home/alice" now')).includes("alice"));
});

test("a long message keeps its preview, cut to the limit", () => {
  const out = redactText("build complete ".repeat(50));
  assert.ok(out.startsWith("build complete build complete"), out);
  assert.equal(Array.from(out).length, 600);
  assert.ok(out.endsWith("\u2026"));
});

test("a chat send is a message to the chat it names, by name or worktree path", () => {
  assert.deepEqual(runnerSends("node scripts/rivet-chat.mjs send /work/chats/fix-it --text 'From monitor: go'"), [{ chat: "fix-it", text: "go" }]);
  assert.deepEqual(runnerSends("rivet-chat send fix-it --repo R --text=hello; echo done"), [{ chat: "fix-it", text: "hello" }]);
  assert.deepEqual(runnerSends("node scripts/rivet.mjs chat send fix-it --text hello"), [{ chat: "fix-it", text: "hello" }]);
  assert.equal(runnerSends('rivet-chat send fix --text "$(cat f)"')[0].chat, "fix");
  assert.notEqual(runnerSends('rivet-chat send fix --text "$(cat f)"')[0].text, "$(cat f)");
  assert.deepEqual(runnerSends("rivet-chat read fix --lines 3"), []);
  assert.deepEqual(runnerSends("node scripts/rivet.mjs chat ls"), []);
});

test("only a chat send that runs is a send: never an argument of another command", () => {
  assert.deepEqual(runnerSends("printf '%s\\n' rivet-chat send monitor --text approved"), []);
  assert.deepEqual(runnerSends("echo node rivet-chat.mjs send monitor --text approved"), []);
  assert.deepEqual(runnerSends("cd x && FOO=1 node scripts/rivet-chat.mjs send fix --text hi"), [{ chat: "fix", text: "hi" }]);
  assert.deepEqual(runnerSends("true; /usr/bin/env node rivet-chat send fix --text hi"), [{ chat: "fix", text: "hi" }]);
});

test("a Bash chat send and a SendMessage are messages, anything else is none", async () => {
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
  assert.deepEqual(await messagesOf(bash("rivet-chat send fix --text hello"), "/work/chats/this"), [{ to: "fix", text: "hello" }]);
  assert.deepEqual(await messagesOf(bash("node scripts/rivet.mjs chat send fix --text hello"), "/work/chats/this"), [{ to: "fix", text: "hello" }]);
  assert.deepEqual(await messagesOf(bash("git status"), "/work/chats/this"), []);
  const send = (to) => ({ tool_name: "SendMessage", tool_input: { to, message: "hello" } });
  assert.deepEqual(await messagesOf(send("fix"), "/work/chats/this"), [{ to: "fix", text: "hello" }]);
  // An in-process subagent is no chat.
  assert.deepEqual(await messagesOf(send("a0123456789"), "/work/chats/this"), []);
});
