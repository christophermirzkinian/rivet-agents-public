import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type * as FsPromises from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IncomingMessage, ServerResponse } from "node:http";
import { serveStatic } from "../src/server/static.js";
import { APP_NAME, nameHostedAgent } from "../src/shared/names.js";

// The web root holds the build; a request reaches nothing else: no link out of it, no dotfile, no "..".

/** Every file the server opens, and a swap a test makes in the web root just before the next open. */
const opens = vi.hoisted(() => ({
  handles: [] as FileHandle[],
  before: null as null | (() => void),
  // No /proc, as on macOS: the fallback check runs on every host. `afterOpen` swaps once the open file is asked for
  // (before the path is resolved again), `beforeCheck` just before the check's lstat.
  noProc: false,
  afterOpen: null as null | (() => void),
  beforeCheck: null as null | (() => void),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    readlink: async (...args: Parameters<typeof real.readlink>) => {
      if (String(args[0]).startsWith("/proc/")) {
        const swap = opens.afterOpen;
        opens.afterOpen = null;
        swap?.();
        if (opens.noProc) throw Object.assign(new Error("no /proc"), { code: "ENOENT" });
      }
      return real.readlink(...args);
    },
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      const swap = opens.beforeCheck;
      opens.beforeCheck = null;
      swap?.();
      return real.lstat(...args);
    },
    stat: async (...args: Parameters<typeof real.stat>) => {
      const swap = opens.beforeCheck;
      opens.beforeCheck = null;
      swap?.();
      return real.stat(...args);
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const swap = opens.before;
      opens.before = null;
      swap?.();
      const handle = await real.open(...args);
      opens.handles.push(handle);
      return handle;
    },
  };
});

const page = (app: string) => `<html><head></head><body>${app}</body></html>`;
let base = "";
let root = "";

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "static-"));
  root = path.join(base, "web");
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), page(APP_NAME));
  fs.writeFileSync(path.join(root, "manifest.webmanifest"), JSON.stringify({ name: APP_NAME }));
  fs.writeFileSync(path.join(root, "sw.js"), `// ${APP_NAME} sw`);
  fs.writeFileSync(path.join(root, "assets", "app-1.js"), "console.log(1)");
  fs.writeFileSync(path.join(base, "secret.txt"), "outside");
  opens.handles = [];
  opens.before = null;
  opens.noProc = false;
  opens.afterOpen = null;
  opens.beforeCheck = null;
});

afterEach(() => {
  nameHostedAgent(null);
  fs.rmSync(base, { recursive: true, force: true });
});

/** A response as serveStatic uses one; `stalls` holds each inactivity timeout it sets, and what that timeout does. */
const response = () => {
  const head: { status?: number; headers?: Record<string, string> } = {};
  const stalls: { ms: number; drop: () => void }[] = [];
  const out = Object.assign(new PassThrough(), {
    writeHead: (status: number, headers: Record<string, string>) => {
      Object.assign(head, { status, headers });
      return out;
    },
    setTimeout: (ms: number, drop: () => void) => {
      stalls.push({ ms, drop });
      return out;
    },
  });
  return { out, head, stalls };
};

const serve = async (rawPath: string, accept = "*/*", method = "GET") => {
  const { out, head } = response();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((done) => out.on("end", done));
  const request = { method, headers: { accept } } as IncomingMessage;
  const served = await serveStatic(request, out as unknown as ServerResponse, root, rawPath);
  if (!served) return { status: 404, body: "" };
  await ended;
  return { status: head.status, headers: head.headers, body: Buffer.concat(chunks).toString("utf8") };
};

describe("serveStatic", () => {
  it("serves the build's files, hashed assets for good", async () => {
    const asset = await serve("/assets/app-1.js");
    expect(asset).toMatchObject({ status: 200, body: "console.log(1)" });
    expect(asset.headers?.["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(await serve("/")).toMatchObject({ status: 200, body: page(APP_NAME) });
    expect(await serve("/chat/one", "text/html")).toMatchObject({ status: 200, body: page(APP_NAME) });
    expect(await serve("/missing.js")).toEqual({ status: 404, body: "" });
  });

  it("renames the app in the index, the manifest and the service worker", async () => {
    nameHostedAgent(null, "Acme Agents");
    expect((await serve("/index.html")).body).toBe(page("Acme Agents"));
    expect((await serve("/")).body).toBe(page("Acme Agents"));
    expect(JSON.parse((await serve("/manifest.webmanifest")).body)).toEqual({ name: "Acme Agents" });
    expect((await serve("/sw.js")).body).toBe("// Acme Agents sw");
    expect((await serve("/assets/app-1.js")).body).toBe("console.log(1)");
  });

  it("refuses a link inside the root that leads out of it", async () => {
    fs.symlinkSync(path.join(base, "secret.txt"), path.join(root, "leak.txt"));
    fs.symlinkSync(base, path.join(root, "up"));
    expect(await serve("/leak.txt")).toEqual({ status: 404, body: "" });
    expect(await serve("/leak.txt", "text/html")).toEqual({ status: 404, body: "" });
    expect(await serve("/up/secret.txt")).toEqual({ status: 404, body: "" });
  });

  it("serves a link that stays inside the root, as the file it leads to", async () => {
    fs.symlinkSync(path.join(root, "assets", "app-1.js"), path.join(root, "alias.js"));
    fs.symlinkSync(path.join(root, "index.html"), path.join(root, "home.html"));
    expect(await serve("/alias.js")).toMatchObject({ status: 200, body: "console.log(1)" });
    nameHostedAgent(null, "Acme Agents");
    expect((await serve("/home.html")).body).toBe(page("Acme Agents"));
  });

  it("refuses dotfiles and dot-folders, and a link to one", async () => {
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=1");
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".git", "config"), "[core]");
    fs.mkdirSync(path.join(root, ".well-known"));
    fs.writeFileSync(path.join(root, ".well-known", "x.txt"), "x");
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "env.txt"));
    for (const p of ["/.env", "/.git/config", "/.git/", "/assets/.hidden", "/.well-known/x.txt", "/%2eenv", "/env.txt"]) {
      expect(await serve(p), p).toEqual({ status: 404, body: "" });
      expect(await serve(p, "text/html"), p).toEqual({ status: 404, body: "" });
    }
  });

  it("refuses .. and encoded traversal", async () => {
    for (const p of ["/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "/%2E%2E%2Fsecret.txt", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt", "/..%5csecret.txt", "/%00", "/%zz"]) {
      expect(await serve(p), p).toEqual({ status: 404, body: "" });
      expect(await serve(p, "text/html"), p).toEqual({ status: 404, body: "" });
    }
    // Decoded once, it names a folder called "%2e%2e": no such file, so a page gets the app.
    expect(await serve("/%252e%252e/secret.txt")).toEqual({ status: 404, body: "" });
    expect(await serve("/%252e%252e/secret.txt", "text/html")).toMatchObject({ status: 200, body: page(APP_NAME) });
  });

  it("serves nothing when the web root is missing", async () => {
    fs.rmSync(root, { recursive: true });
    expect(await serve("/", "text/html")).toEqual({ status: 404, body: "" });
  });

  it("refuses a raw backslash, and a folder or a FIFO where a file is asked for", async () => {
    execFileSync("mkfifo", [path.join(root, "assets", "pipe.js")]);
    for (const p of ["/assets\\app-1.js", "/assets", "/assets/pipe.js"]) expect(await serve(p), p).toEqual({ status: 404, body: "" });
    expect(opens.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("answers HEAD with no body and closes the file, renamed or not", async () => {
    nameHostedAgent(null, "Acme Agents");
    expect(await serve("/assets/app-1.js", "*/*", "HEAD")).toMatchObject({ status: 200, body: "" });
    expect(await serve("/", "text/html", "HEAD")).toMatchObject({ status: 200, body: "", headers: { "content-type": "text/html; charset=utf-8" } });
    expect(opens.handles.map((handle) => handle.fd)).toEqual([-1, -1]);
  });

  it("gives the long cache only to a file that is really under assets/, whatever the path asked", async () => {
    fs.symlinkSync(path.join(root, "index.html"), path.join(root, "assets", "page.js"));
    expect((await serve("/assets/page.js")).headers?.["cache-control"]).toBe("no-cache");
  });

  it("serves nothing when a folder in the path turns into a link out of the root just before the open", async () => {
    fs.mkdirSync(path.join(base, "outside"));
    fs.writeFileSync(path.join(base, "outside", "app-1.js"), "outside");
    opens.before = () => {
      fs.renameSync(path.join(root, "assets"), path.join(root, "kept"));
      fs.symlinkSync(path.join(base, "outside"), path.join(root, "assets"));
    };
    expect(await serve("/assets/app-1.js")).toEqual({ status: 404, body: "" });
    expect(opens.handles.map((handle) => handle.fd)).toEqual([-1]);
  });

  it("with no /proc, serves nothing when the folder swap is put back and the file turned into a link to what was opened", async () => {
    opens.noProc = true;
    fs.mkdirSync(path.join(base, "outside"));
    fs.writeFileSync(path.join(base, "outside", "app-1.js"), "outside");
    opens.before = () => {
      fs.renameSync(path.join(root, "assets"), path.join(root, "kept"));
      fs.symlinkSync(path.join(base, "outside"), path.join(root, "assets"));
    };
    // After the open the real assets/ goes back, so the path resolves inside again; then, before the check, its
    // app-1.js turns into a link to the outside file that was opened.
    opens.afterOpen = () => {
      fs.rmSync(path.join(root, "assets"));
      fs.renameSync(path.join(root, "kept"), path.join(root, "assets"));
    };
    opens.beforeCheck = () => {
      fs.rmSync(path.join(root, "assets", "app-1.js"));
      fs.symlinkSync(path.join(base, "outside", "app-1.js"), path.join(root, "assets", "app-1.js"));
    };
    expect(await serve("/assets/app-1.js")).toEqual({ status: 404, body: "" });
    expect(opens.handles.map((handle) => handle.fd)).toEqual([-1]);
  });

  it("with no /proc, still serves a file inside the root", async () => {
    opens.noProc = true;
    expect(await serve("/assets/app-1.js")).toMatchObject({ status: 200, body: "console.log(1)" });
  });

  it("never waits on a file that turns into a FIFO just before the open", async () => {
    const file = path.join(root, "assets", "app-1.js");
    opens.before = () => {
      fs.rmSync(file);
      execFileSync("mkfifo", [file]);
    };
    const waited = new Promise((done) => setTimeout(() => done("waited"), 2_000));
    const result = await Promise.race([serve("/assets/app-1.js"), waited]);
    // Lets a blocked open go, so a failing run still ends.
    if (result === "waited") fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
    expect(result).toEqual({ status: 404, body: "" });
  });

  it("drops a client that stops reading after a minute, which closes the file", async () => {
    fs.writeFileSync(path.join(root, "assets", "big.js"), "x".repeat(4 << 20));
    const { out, stalls } = response();
    const request = { method: "GET", headers: { accept: "*/*" } } as IncomingMessage;
    expect(await serveStatic(request, out as unknown as ServerResponse, root, "/assets/big.js")).toBe(true);
    expect(stalls.map((stall) => stall.ms)).toEqual([60_000]);
    const [handle] = opens.handles;
    const closed = new Promise((done) => (handle as unknown as NodeJS.EventEmitter | undefined)?.once("close", done));
    stalls[0]?.drop();
    await closed;
    expect(handle?.fd).toBe(-1);
  });
});
