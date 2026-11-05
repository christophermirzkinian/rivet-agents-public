import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RIVET_ENV = /^RIVET_|^CLAUDE_/;

/** A clean copy of this process's environment, so a developer's own settings never reach a hook under test. */
export const cleanEnv = (env = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !RIVET_ENV.test(name))),
  ...env,
});

/** Runs a hook with `input` on stdin; its parsed output, or null when it said nothing. A hook always exits 0. */
export function runHook(name, input, env = {}) {
  const hook = fileURLToPath(new URL(`../${name}`, import.meta.url));
  const result = spawnSync(process.execPath, [hook], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: cleanEnv(env),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${name} exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

/** The same without blocking, for a hook that talks to a server running in this process. */
export function runHookAsync(name, input, env = {}) {
  const hook = fileURLToPath(new URL(`../${name}`, import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], { env: cleanEnv(env), stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${name} exited ${code}`));
      else resolve(out.trim() ? JSON.parse(out) : null);
    });
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}
