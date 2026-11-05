import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExecError, fingerprint, formatLog, makeExec, readToken, resolveBin, scriptCommand, serverOrigin, withoutRivetTokens } from "../lib/config.mjs";

const TOKEN = "ab".repeat(32);

test("serverOrigin accepts https and local http only", () => {
  assert.equal(serverOrigin(undefined), "http://127.0.0.1:8130");
  assert.equal(serverOrigin("https://rivet.example.com/some/path?x=1"), "https://rivet.example.com");
  assert.equal(serverOrigin("http://localhost:8080"), "http://localhost:8080");
  assert.equal(serverOrigin("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.throws(() => serverOrigin("http://rivet.example.com"));
  assert.throws(() => serverOrigin("http://localhost.evil.com"));
  assert.throws(() => serverOrigin("ftp://localhost"));
  assert.throws(() => serverOrigin("https://u:p@rivet.example.com"));
  assert.throws(() => serverOrigin("not a url"));
});

test("fingerprint is sha256 of the token, first 12 hex", () => {
  assert.equal(fingerprint(TOKEN), createHash("sha256").update(TOKEN).digest("hex").slice(0, 12));
  assert.equal(fingerprint(TOKEN).length, 12);
});

test("readToken reads the Keychain item and trims only the trailing newline", async () => {
  /** @type {any[]} */
  const calls = [];
  const exec = async (/** @type {string} */ file, /** @type {string[]} */ args) => {
    calls.push([file, args]);
    return { stdout: `${TOKEN}\n`, stderr: "" };
  };
  assert.equal(await readToken(exec, "RIVET_BRIDGE_TOKEN", {}), TOKEN);
  assert.deepEqual(calls, [
    ["/usr/bin/security", ["find-generic-password", "-s", "rivet-agents", "-a", "RIVET_BRIDGE_TOKEN", "-w"]],
  ]);
});

test("readToken takes the token from the environment first, and reads no Keychain then", async () => {
  const other = "cd".repeat(32);
  let reads = 0;
  const exec = async () => {
    reads += 1;
    return { stdout: `${TOKEN}\n`, stderr: "" };
  };
  assert.equal(await readToken(exec, "RIVET_BRIDGE_TOKEN", { RIVET_BRIDGE_TOKEN: other }), other);
  assert.equal(reads, 0);
  await assert.rejects(readToken(exec, "RIVET_BRIDGE_TOKEN", { RIVET_BRIDGE_TOKEN: "short" }), /not 64 hex/);
});

test("readToken rejects malformed tokens without echoing them", async () => {
  const exec = async () => ({ stdout: "secret-but-short\n", stderr: "" });
  await assert.rejects(readToken(exec, "RIVET_BOARD_TOKEN", {}), (err) => {
    assert.equal(/** @type {Error} */ (err).message.includes("secret"), false);
    return true;
  });
  const failing = async () => {
    throw new Error("security: SecKeychainSearchCopyNext: The specified item could not be found");
  };
  await assert.rejects(readToken(failing, "RIVET_BOARD_TOKEN", {}), /could not read RIVET_BOARD_TOKEN/);
});

test("ExecError never carries the argument list", () => {
  const e = new ExecError("/opt/homebrew/bin/gh", { code: 1 }, "\nHTTP 404: Not Found\nmore");
  assert.equal(e.message, "gh exit 1");
  assert.equal(e.stderrFirstLine, "HTTP 404: Not Found");
  assert.equal(new ExecError("/x/somecli", { killed: true, signal: "SIGTERM" }, "").message, "somecli timed out");
});

test("resolveBin returns an absolute path and ignores relative PATH entries", () => {
  assert.equal(resolveBin("sh", "relative:/bin"), "/bin/sh");
  assert.throws(() => resolveBin("definitely-not-a-binary-xyz", "/bin:/usr/bin"));
});

test("formatLog keeps one line", () => {
  const line = formatLog("drop", { id: "r1", reason: "a b\nc" });
  assert.match(line, /^\d{4}-\d\d-\d\dT[\d:.]+Z drop id=r1 reason=a_b_c$/);
});

test("withoutRivetTokens drops every Rivet credential, today's and later ones, and keeps the rest", () => {
  const env = withoutRivetTokens({
    RIVET_BRIDGE_TOKEN: "a",
    RIVET_BOARD_TOKEN: "b",
    RIVET_ENROLL_TOKEN: "c",
    RIVET_HOST_TOKEN: "d",
    RIVET_NEW_TOKEN_2: "e",
    RIVET_URL: "https://x",
    PATH: "/bin",
  });
  assert.deepEqual(env, { RIVET_URL: "https://x", PATH: "/bin" });
});

test("scriptCommand runs a #! script through its interpreter, as the kernel would, and anything else as it is", () => {
  const head = (/** @type {string} */ text) => () => text;
  assert.deepEqual(scriptCommand("/usr/local/bin/somecli", ["chat", "list"], head("#!/usr/bin/env bash\nset -e\n")), {
    file: "/usr/bin/env",
    args: ["bash", "/usr/local/bin/somecli", "chat", "list"],
  });
  assert.deepEqual(scriptCommand("/s/x", ["a"], head("#! /bin/sh\r\n")), { file: "/bin/sh", args: ["/s/x", "a"] });
  // A binary, an unreadable file, a relative interpreter, two arguments or a cut-off first line run the file itself.
  const direct = { file: "/b/x", args: ["a"] };
  assert.deepEqual(scriptCommand("/b/x", ["a"], head("\u007fELF...")), direct);
  assert.deepEqual(scriptCommand("/b/x", ["a"], () => { throw new Error("EACCES"); }), direct);
  assert.deepEqual(scriptCommand("/b/x", ["a"], head("#!bash\n")), direct);
  assert.deepEqual(scriptCommand("/b/x", ["a"], head("#!/usr/bin/env -S node --flag\n")), direct);
  assert.deepEqual(scriptCommand("/b/x", ["a"], head(`#!/usr/bin/env ${"x".repeat(300)}`)), direct);
});

test("makeExec runs a script through its #! line, not by exec'ing the file", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-exec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Not executable: exec'ing it would fail, so a success proves the interpreter ran it.
  const script = path.join(dir, "wrapper");
  fs.writeFileSync(script, '#!/bin/sh\nprintf "%s|%s" "$0" "$1"\n', { mode: 0o644 });
  const out = await makeExec()(script, ["one arg"], { timeout: 10_000 });
  assert.equal(out.stdout, `${script}|one arg`);
});

test("makeExec hands `input` to the command's stdin", async () => {
  const out = await makeExec()("/bin/cat", [], { timeout: 10_000, input: 'words "$(id)"\nline two' });
  assert.equal(out.stdout, 'words "$(id)"\nline two');
});
