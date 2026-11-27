import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/push-board.mjs", import.meta.url));
const need = (id) => ({ id, kind: "decision", title: id });

for (const site of ["board write-back", "media board", "pushed sidecar"]) {
  test(`${site} preserves old content after a partial write fails`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-atomic-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "board.json");
    fs.writeFileSync(file, JSON.stringify({ updatedAt: "x", needs: [need("mine")], coming: [], chats: [] }));
    fs.writeFileSync(`${file}.pushed`, JSON.stringify({ version: 1, needs: ["mine"], coming: [], chats: [] }));
    const target = site === "pushed sidecar" ? `${file}.pushed` : file;
    const previous = fs.readFileSync(target, "utf8");
    // Each HTTP response is a fixture: the subprocess never opens a socket.
    const preload = `data:text/javascript,${encodeURIComponent(`
      import fs from "node:fs";
      globalThis.fetch = async (url, init) => {
        if (url.includes("/api/bridge/media/")) return new Response("{}", { status: 201 });
        if (url.endsWith("/api/board")) return Response.json(init.method === "PUT"
          ? { version: 11 }
          : { version: 10, board: { needs: ${JSON.stringify([need("mine"), need("theirs")])} } });
        throw new Error("unexpected fixture request");
      };
      const target = ${JSON.stringify(target)};
      const open = fs.openSync;
      const write = fs.writeFileSync;
      const descriptors = new Set();
      fs.openSync = (name, ...args) => {
        const fd = open(name, ...args);
        if (typeof name === "string" && name.startsWith(target + ".tmp-")) descriptors.add(fd);
        return fd;
      };
      fs.writeFileSync = (name, ...args) => {
        if (name === target || descriptors.has(name)) {
          write(name, "{");
          process.stderr.write("injected partial state write\\n");
          throw new Error("partial state write failed");
        }
        return write(name, ...args);
      };
    `)}`;
    let args = [file];
    if (site === "media board") {
      const still = path.join(dir, "still.png");
      fs.writeFileSync(still, Buffer.from("89504e470d0a1a0a0001", "hex"));
      args = ["--media", "mine", "--still", still, file];
    }
    const result = spawnSync(process.execPath, ["--import", preload, SCRIPT, ...args], {
      encoding: "utf8", timeout: 20_000,
      env: { PATH: process.env.PATH, RIVET_URL: "http://127.0.0.1:8130", RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: "cd".repeat(32) },
    });
    assert.equal(result.error, undefined);
    assert.match(result.stderr, /injected partial state write/);
    assert.equal(fs.readFileSync(target, "utf8"), previous);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
  });
}
