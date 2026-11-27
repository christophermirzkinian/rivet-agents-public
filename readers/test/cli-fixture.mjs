import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run the real entry point with no inherited credentials or host configuration. The preload intercepts commands
// before reader imports, serves empty work lists, and reports every attempted side effect on a separate pipe.
// `behaviours` is what the stubbed Rivet behaviour read serves; a reader's own test passes its entry, so this shared
// fixture names no reader-specific behaviour. `commands` adds a reader's own stubbed commands the same way:
// { name: { args: [leading args...], stdout } }.
export function readerCli(reader, args, { repo = true, behaviours = [], directories = [], commands = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "reader-cli-"));
  const home = path.join(base, "home");
  const bin = path.join(base, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  for (const dir of directories) fs.mkdirSync(path.join(home, dir), { recursive: true });
  for (const name of ["gh", "git", "flyctl", "claude", ...Object.keys(commands)]) fs.writeFileSync(path.join(bin, name), "", { mode: 0o755 });
  const preload = `
    import cp from "node:child_process";
    import fs from "node:fs";
    import http from "node:http";
    import https from "node:https";
    import path from "node:path";
    import { EventEmitter } from "node:events";
    import { PassThrough } from "node:stream";
    import { syncBuiltinESMExports } from "node:module";

    const calls = [];
    const commands = ${JSON.stringify(commands)};
    const write = fs.writeSync.bind(fs);
    process.on("exit", () => write(3, JSON.stringify(calls)));
    const blocked = (kind) => (...args) => {
      calls.push({ kind });
      throw new Error("unexpected fixture " + kind);
    };
    for (const name of ["exec", "execSync", "execFileSync", "spawn", "spawnSync", "fork"]) cp[name] = blocked(name);
    cp.execFile = (file, args, opts, done) => {
      const bin = path.basename(file);
      calls.push({ kind: "execFile", bin, args });
      let stdout;
      if (bin === "security") stdout = "0".repeat(64); // Synthetic board credential, never a Keychain read.
      else if (bin === "gh" && args[0] === "auth") stdout = "fixture-only";
      else if (bin === "gh" && args.includes("-i")) {
        const body = args.some((a) => a.includes("actions/runs?")) ? { workflow_runs: [] } : [];
        stdout = "HTTP/2.0 200 OK\\r\\nEtag: fixture\\r\\n\\r\\n" + JSON.stringify(body);
      } else if (bin === "gh" && (args.includes("list") || args.includes("--paginate"))) stdout = "[]";
      else if (bin === "git") stdout = args.includes("rev-parse") ? "a".repeat(40) : "";
      else if (Object.hasOwn(commands, bin) && commands[bin].args.every((arg, i) => args[i] === arg)) stdout = commands[bin].stdout;
      else if (file === process.execPath && args[1] === "board") stdout = JSON.stringify({ version: 1, board: { chats: [] } });
      else if (bin === "flyctl" && args[0] === "apps") stdout = "[]";
      else throw new Error("unexpected fixture command");
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => done(null, stdout, ""));
      return child;
    };
    globalThis.fetch = async (url) => {
      calls.push({ kind: "fetch", url: String(url) });
      if (String(url) !== "http://127.0.0.1:1/api/behaviours") throw new Error("unexpected fixture fetch");
      return { ok: true, json: async () => ({ behaviours: ${JSON.stringify(behaviours)} }) };
    };
    for (const transport of [http, https]) {
      transport.request = blocked("request");
      transport.get = blocked("get");
    }
    for (const name of ["readFileSync", "readdirSync", "lstatSync", "statSync", "accessSync", "existsSync", "openSync", "writeFileSync", "appendFileSync", "mkdirSync", "linkSync", "renameSync", "rmSync", "unlinkSync"]) {
      const original = fs[name].bind(fs);
      fs[name] = (...args) => {
        if (typeof args[0] === "string" && args[0].startsWith(process.env.HOME + path.sep)) {
          calls.push({ kind: name, file: path.relative(process.env.HOME, args[0]) });
        }
        return original(...args);
      };
    }
    syncBuiltinESMExports();
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(new URL(`../${reader}.mjs`, import.meta.url)), ...args], {
      cwd: home,
      env: {
        HOME: home,
        PATH: bin,
        RIVET_ASKS_DIR: path.join(home, "asks"),
        RIVET_MEMORY_DIR: path.join(home, "memory"),
        RIVET_URL: "http://127.0.0.1:1",
        ...(repo ? { RIVET_REPO: home } : {}),
      },
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    return { ...result, calls: JSON.parse(result.output[3]), files: fs.readdirSync(home, { recursive: true }) };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

export const unexpectedArgs = [
  ["--dryrun"],
  ["--dry-run", "--dryrun"],
  ["--dryrun", "--dry-run"],
  ["--dry-run=true"],
  ["--dry-run", "false"],
  ["--help"],
  ["--"],
  ["extra"],
  [""],
  ["bad\nargument"],
];
