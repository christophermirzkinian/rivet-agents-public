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

test("a port, from --port or a localhost origin, is written for the server, the bridge and the CLI; an https origin's is not", () => {
  const settings = (...args) => {
    const dir = fs.mkdtempSync(path.join(tmp, "port-"));
    main(["--dir", dir, ...args], { out: () => {}, run: noKeychain });
    return parseEnv(fs.readFileSync(path.join(dir, ".env"), "utf8"));
  };
  const local = settings("--origin", "http://localhost:9131");
  assert.deepEqual([local.RIVET_ORIGIN, local.RIVET_PORT, local.RIVET_URL], ["http://localhost:9131", "9131", "http://127.0.0.1:9131"]);
  const served = settings("--origin", "https://rivet.example.com", "--port", "9131");
  assert.deepEqual([served.RIVET_ORIGIN, served.RIVET_PORT, served.RIVET_URL], ["https://rivet.example.com", "9131", "http://127.0.0.1:9131"]);
  const proxied = settings("--origin", "https://rivet.example.com:8443");
  assert.deepEqual([proxied.RIVET_PORT, proxied.RIVET_URL], [undefined, undefined]);
  const usual = settings("--origin", "http://localhost:8130");
  assert.deepEqual([usual.RIVET_PORT, usual.RIVET_URL], [undefined, undefined]);
  const six = settings("--origin", "http://[::1]:9131");
  assert.deepEqual([six.RIVET_PORT, six.RIVET_URL], ["9131", "http://127.0.0.1:9131"]);
  const padded = settings("--origin", "https://rivet.example.com", "--port", "08130");
  assert.deepEqual([padded.RIVET_PORT, padded.RIVET_URL], [undefined, undefined]);
  const alone = settings("--port", "9131");
  assert.deepEqual([alone.RIVET_ORIGIN, alone.RIVET_PORT, alone.RIVET_URL], ["http://localhost:9131", "9131", "http://127.0.0.1:9131"]);
});

test("a kept .env says which of the --origin and --port given it does not take, and nothing when none was given", () => {
  const run = (dir, ...args) => {
    const lines = [];
    main(["--dir", dir, ...args], { out: (l) => lines.push(l), run: noKeychain });
    return lines.filter((l) => l.startsWith("It keeps"));
  };
  const dir = path.join(tmp, "kept-port");
  main(["--dir", dir], { out: () => {}, run: noKeychain });
  assert.deepEqual(run(dir, "--origin", "https://rivet.example.com", "--port", "9131"), [
    "It keeps its own settings, not the ones given here: set RIVET_ORIGIN=https://rivet.example.com, RIVET_PORT=9131, RIVET_URL=http://127.0.0.1:9131 in it (or run with --force), then npm run install-bridge again.",
  ]);
  assert.deepEqual(run(dir, "--port", "8130"), []);
  assert.deepEqual(run(dir, "--origin", "http://localhost:8130"), []);
  assert.deepEqual(run(dir, "--port", "9131"), [
    "It keeps its own settings, not the ones given here: set RIVET_ORIGIN=http://localhost:9131, RIVET_PORT=9131, RIVET_URL=http://127.0.0.1:9131 in it (or run with --force), then npm run install-bridge again.",
  ]);

  const served = path.join(tmp, "kept-served");
  main(["--dir", served, "--origin", "https://rivet.example.com", "--port", "9131"], { out: () => {}, run: noKeychain });
  assert.deepEqual(run(served), []);
  assert.deepEqual(run(served, "--repos", "example-org/example-repo"), []);
  assert.deepEqual(run(served, "--port", "09131"), []);
  assert.deepEqual(run(served, "--origin", "https://rivet.example.com"), []);
  assert.deepEqual(run(served, "--origin", "https://rivet.example.com", "--repos","example-org/example-repo"), []);
  assert.deepEqual(run(served, "--port", "9200"), [
    "It keeps its own settings, not the ones given here: set RIVET_PORT=9200, RIVET_URL=http://127.0.0.1:9200 in it (or run with --force), then npm run install-bridge again.",
  ]);
});

test("setup refuses a bad origin, port or repo", () => {
  assert.throws(() => main(["--dir", path.join(tmp, "bad"), "--origin", "ftp://x"], { out: () => {} }), /http/);
  assert.throws(() => main(["--dir", path.join(tmp, "bad"), "--port", "99999"], { out: () => {} }), /not a port/);
  assert.throws(() => main(["--dir", path.join(tmp, "bad"), "--origin", "http://localhost:8130", "--port", "9131"], { out: () => {} }), /not the port in --origin/);
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
