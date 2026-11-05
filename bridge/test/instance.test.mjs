import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { acquireInstanceLock } from "../lib/instance.mjs";

/** A loopback port free right now. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((done) => probe.listen({ host: "127.0.0.1", port: 0 }, () => done(undefined)));
  const { port } = /** @type {net.AddressInfo} */ (probe.address());
  await new Promise((done) => probe.close(() => done(undefined)));
  return port;
}

test("a second daemon is refused while the first holds the lock, and takes it once released", async () => {
  const port = await freePort();
  const first = await acquireInstanceLock({ port });
  assert.equal(first.ok, true);
  const second = await acquireInstanceLock({ port });
  assert.equal(second.ok, false);
  assert.match(second.ok ? "" : second.reason, /another bridge is running/);
  if (first.ok) await first.release();
  const third = await acquireInstanceLock({ port });
  assert.equal(third.ok, true);
  if (third.ok) await third.release();
});

test("simultaneous starts: exactly one takes the lock", async () => {
  const port = await freePort();
  const results = await Promise.all(Array.from({ length: 8 }, () => acquireInstanceLock({ port })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  for (const r of results) if (r.ok) await r.release();
});

test("the lock dies with its process: a child that held it and was killed leaves it free", async () => {
  const { spawn } = await import("node:child_process");
  const port = await freePort();
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen({host:"127.0.0.1",port:${port},exclusive:true},()=>console.log("held"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((done) => child.stdout.once("data", done));
  assert.equal((await acquireInstanceLock({ port })).ok, false);
  child.kill("SIGKILL");
  await new Promise((done) => child.once("exit", done));
  const after = await acquireInstanceLock({ port });
  assert.equal(after.ok, true);
  if (after.ok) await after.release();
});
