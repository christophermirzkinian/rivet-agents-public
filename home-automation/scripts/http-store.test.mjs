import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "http-store.sh");
const write = (config) => spawnSync("bash", [SCRIPT, config], { encoding: "utf8" });

test("a config dir with no HTTP store gets HA 2026.10's store on 127.0.0.1:8123, readable by its owner only", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "http-store-"));
  try {
    const config = path.join(dir, "config");
    assert.equal(write(config).status, 0);
    const store = path.join(config, ".storage", "http");
    const saved = JSON.parse(readFileSync(store, "utf8"));
    const { created_at: createdAt, ...stable } = saved.data.stable;
    assert.match(createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
    assert.deepEqual({ ...saved, data: { ...saved.data, stable } }, {
      version: 2,
      minor_version: 2,
      key: "http",
      data: {
        stable: {
          server_host: ["127.0.0.1"],
          server_port: 8123,
          cors_allowed_origins: ["https://cast.home-assistant.io"],
          login_attempts_threshold: -1,
          ip_ban_enabled: true,
          ssl_profile: "modern",
          use_x_frame_options: true,
          error: null,
          error_message: null,
        },
        pending: null,
        yaml_migration_done: true,
      },
    });
    assert.equal(statSync(store).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(store)).mode & 0o777, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the store says the YAML migration is done, so HA starts on it whether or not configuration.yaml has an http: block", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "http-store-"));
  try {
    for (const yaml of ["homeassistant:\n  name: Home\n", "homeassistant:\n  name: Home\nhttp: {}\n"]) {
      const config = mkdtempSync(path.join(dir, "config-"));
      writeFileSync(path.join(config, "configuration.yaml"), yaml);
      assert.equal(write(config).status, 0);
      const { data } = JSON.parse(readFileSync(path.join(config, ".storage", "http"), "utf8"));
      assert.equal(data.yaml_migration_done, true);
      assert.equal(data.pending, null);
      assert.deepEqual(data.stable.server_host, ["127.0.0.1"]);
      assert.equal(readFileSync(path.join(config, "configuration.yaml"), "utf8"), yaml);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing HTTP store is never overwritten", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "http-store-"));
  try {
    const store = path.join(dir, ".storage", "http");
    mkdirSync(path.dirname(store));
    writeFileSync(store, "HA's own");
    assert.equal(write(dir).status, 0);
    assert.equal(readFileSync(store, "utf8"), "HA's own");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
