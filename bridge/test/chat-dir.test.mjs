import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chatDir } from "../lib/config.mjs";

test("chatDir: RIVET_CHAT_DIR when it is an absolute folder with no link in it, else home", () => {
  // The temp folder itself sits under a link on macOS (/var is /private/var).
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-dir-")));
  try {
    const home = path.join(base, "home");
    const chat = path.join(home, "chat");
    fs.mkdirSync(chat, { recursive: true });
    fs.writeFileSync(path.join(home, "file"), "");
    fs.symlinkSync(chat, path.join(home, "link"));
    assert.equal(chatDir({ RIVET_CHAT_DIR: chat }, home), chat);
    assert.equal(chatDir({ RIVET_CHAT_DIR: `${chat}/` }, home), chat);
    assert.equal(chatDir({}, home), home);
    assert.equal(chatDir({ RIVET_CHAT_DIR: "" }, home), home);
    assert.equal(chatDir({ RIVET_CHAT_DIR: "chat" }, home), home, "a relative path");
    assert.equal(chatDir({ RIVET_CHAT_DIR: path.join(home, "missing") }, home), home);
    assert.equal(chatDir({ RIVET_CHAT_DIR: path.join(home, "file") }, home), home, "a file");
    assert.equal(chatDir({ RIVET_CHAT_DIR: path.join(home, "link") }, home), home, "a link to a folder");
    assert.equal(chatDir({ RIVET_CHAT_DIR: `${path.join(home, "link")}/` }, home), home, "a link written with a trailing slash");
    assert.equal(chatDir({ RIVET_CHAT_DIR: path.join(home, "link", ".") }, home), home, "a link written with /.");
    fs.symlinkSync(home, path.join(base, "up"));
    assert.equal(chatDir({ RIVET_CHAT_DIR: path.join(base, "up", "chat") }, home), home, "a link in a parent folder");
    fs.mkdirSync(path.join(home, "deep", "inner"), { recursive: true });
    fs.mkdirSync(path.join(home, "deep", "chat"));
    fs.symlinkSync(path.join(home, "deep", "inner"), path.join(home, "inside"));
    assert.equal(chatDir({ RIVET_CHAT_DIR: `${path.join(home, "inside")}/../chat` }, home), home, "a .. after a link");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
