import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { enrollLink, KEYCHAIN_SERVICE, main, parseEnv } from "../../scripts/setup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rivet-setup-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const noKeychain = () => {
  throw new Error("the Keychain is not touched without --keychain");
};

test("setup writes a 0600 .env with fresh tokens and VAPID keys, and prints the enrolment link", () => {
  const dir = path.join(tmp, "fresh");
  const lines = [];
  assert.equal(main(["--dir", dir, "--origin", "https://rivet.example.com/ignored", "--repos", "example-org/example-repo, example-org/other-repo"], { out: (l) => lines.push(l), run: noKeychain }), 0);
  const file = path.join(dir, ".env");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const env = parseEnv(fs.readFileSync(file, "utf8"));
  for (const name of ["RIVET_BOARD_TOKEN", "RIVET_BRIDGE_TOKEN", "RIVET_ENROLL_TOKEN"]) assert.match(env[name], /^[0-9a-f]{64}$/, name);
  assert.equal(new Set([env.RIVET_BOARD_TOKEN, env.RIVET_BRIDGE_TOKEN, env.RIVET_ENROLL_TOKEN]).size, 3);
  assert.match(env.RIVET_VAPID_PUBLIC_KEY, /^[A-Za-z0-9_-]{80,}$/);
  assert.match(env.RIVET_VAPID_PRIVATE_KEY, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(env.RIVET_ORIGIN, "https://rivet.example.com");
  assert.equal(env.RIVET_VAPID_SUBJECT, "https://rivet.example.com");
  assert.equal(env.RIVET_REPOS, "example-org/example-repo,example-org/other-repo");
  assert.ok(lines.includes(`  ${enrollLink(env.RIVET_ORIGIN, env.RIVET_ENROLL_TOKEN)}`));
  assert.equal(enrollLink("https://rivet.example.com", "ab"), "https://rivet.example.com/#code=ab");
});

test("setup keeps an existing .env unless --force", () => {
  const dir = path.join(tmp, "again");
  main(["--dir", dir], { out: () => {}, run: noKeychain });
  const first = fs.readFileSync(path.join(dir, ".env"), "utf8");
  const lines = [];
  main(["--dir", dir], { out: (l) => lines.push(l), run: noKeychain });
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), first);
  assert.match(lines[0], /^Kept /);
  main(["--dir", dir, "--force"], { out: () => {}, run: noKeychain });
  assert.notEqual(fs.readFileSync(path.join(dir, ".env"), "utf8"), first);
});

test("--keychain stores the bridge and board tokens under the rivet-agents service", () => {
  const dir = path.join(tmp, "keychain");
  const calls = [];
  main(["--dir", dir, "--keychain"], { out: () => {}, run: (cmd, args) => (calls.push([cmd, ...args]), { status: 0 }) });
  const env = parseEnv(fs.readFileSync(path.join(dir, ".env"), "utf8"));
  assert.deepEqual(calls, [
    ["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", "RIVET_BRIDGE_TOKEN", "-w", env.RIVET_BRIDGE_TOKEN],
    ["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", "RIVET_BOARD_TOKEN", "-w", env.RIVET_BOARD_TOKEN],
  ]);
});

test("setup refuses a bad origin or repo", () => {
  assert.throws(() => main(["--dir", path.join(tmp, "bad"), "--origin", "ftp://x"], { out: () => {} }), /http/);
  assert.throws(() => main(["--dir", path.join(tmp, "bad"), "--repos", "nope"], { out: () => {} }), /owner\/name/);
  assert.equal(fs.existsSync(path.join(tmp, "bad", ".env")), false);
});

test("install-bridge --dry-run prints both plists under ~/.rivet-agents and writes nothing", () => {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  const run = (...args) => spawnSync("/bin/bash", [path.join(ROOT, "scripts", "install-bridge.sh"), "--dry-run", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<string>dev\.rivet-agents\.server<\/string>/);
  assert.match(r.stdout, /<string>dev\.rivet-agents\.bridge<\/string>/);
  assert.ok(r.stdout.includes(`<string>${home}/.rivet-agents/app/src/server/main.ts</string>`));
  assert.ok(r.stdout.includes(`<string>${home}/.rivet-agents/app/bridge/rivet-bridge.mjs</string>`));
  assert.ok(r.stdout.includes(`<key>RIVET_DATA_DIR</key>\n    <string>${home}/.rivet-agents/data</string>`));
  assert.ok(r.stdout.includes(`<string>${home}/.rivet-agents/logs/bridge.log</string>`));
  assert.ok(r.stdout.includes(`<string>--env-file=${home}/.rivet-agents/app/.env</string>`));
  assert.doesNotMatch(r.stdout, /TOKEN/);
  assert.deepEqual(fs.readdirSync(home), []);

  const bridgeOnly = run("--no-server");
  assert.equal(bridgeOnly.status, 0, bridgeOnly.stderr);
  assert.doesNotMatch(bridgeOnly.stdout, /dev\.rivet-agents\.server/);
  assert.match(bridgeOnly.stdout, /dev\.rivet-agents\.bridge/);
});

test("the installer never uses sudo", () => {
  const code = fs.readFileSync(path.join(ROOT, "scripts", "install-bridge.sh"), "utf8").split("\n").filter((line) => !/^\s*#/.test(line));
  assert.equal(code.filter((line) => /\bsudo\b/.test(line)).length, 0);
});
