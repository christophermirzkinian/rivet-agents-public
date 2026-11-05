import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { redactLog } from "../src/server/redact.js";
import { bearer, BRIDGE_TOKEN, browser, startServer, type TestServer } from "./helpers.js";

// Made-up secret shapes only, built at run time so no token shape sits in the source.
const GH = `${"gh"}p_${"Zq9".repeat(12)}`;
const PASSWORD = "qzvtkfakepass";
const FAKES = [GH, PASSWORD];
const leaked = (text: string) => FAKES.filter((fake) => text.includes(fake));

describe("log uploads from the bridge", () => {
  it("reads a log upload as one run, so a secret's value on the line below its name goes", () => {
    for (const lines of [
      ["password: |", `  ${PASSWORD}`],
      ["password: | # multiline value", `  correct horse ${PASSWORD}`],
      ['password = """first secret line', `  prefix ${PASSWORD}`, '"""'],
      ["PASS", "WORD: |", `  ${PASSWORD}`],
    ])
      expect(leaked(redactLog(lines, 200).join("\n"))).toEqual([]);
    expect(redactLog(Array.from({ length: 5 }, () => "a"), 4)).toHaveLength(4);
    expect(redactLog([], 200)).toEqual([]);
  });
});

describe("what the bridge token writes is stored and shown redacted", () => {
  let server: TestServer;
  afterEach(async () => server?.close());

  const send = (method: string, path: string, body: unknown, token = BRIDGE_TOKEN) =>
    fetch(`${server.base}${path}`, { method, headers: bearer(token), body: JSON.stringify(body) });
  const dataFiles = () =>
    readdirSync(server.dataDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1"))
      .join("\n");

  it("refuses a token-shaped worker branch", async () => {
    server = await startServer();
    const worker = { worktreeId: "0123456789abcdef", repo: "example-org/example-repo", chat: "fix-login", connected: true, lastOutputAt: 0, agent: "claude", busy: false };
    expect((await send("PUT", "/api/bridge/workers", { workers: [{ ...worker, branch: `feature/${GH}` }] })).status).toBe(400);
    expect((await send("PUT", "/api/bridge/workers", { workers: [{ ...worker, branch: "sam/fix-login" }] })).status).toBe(200);

    const workers = await (await fetch(`${server.base}/api/workers`, { headers: browser(server.cookie()) })).text();
    expect(workers).toContain("sam/fix-login");
    expect(leaked(workers + dataFiles())).toEqual([]);
  });
});
