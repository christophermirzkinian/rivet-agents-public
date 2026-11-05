import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParser } from "../lib/sse.mjs";

/** @param {string[]} chunks */
function parseAll(chunks) {
  const p = new SseParser();
  return chunks.flatMap((c) => p.push(c));
}

test("parses a reply event with id", () => {
  assert.deepEqual(parseAll(['event: reply\nid: r1\ndata: {"a":1}\n\n']), [
    { type: "event", event: "reply", data: '{"a":1}', id: "r1" },
  ]);
});

test("same result for every chunk split", () => {
  const text = ": hi\r\nevent: reply\r\nid: r1\r\ndata: one\r\ndata: two\r\n\r\ndata:three\r\r";
  const whole = parseAll([text]);
  assert.deepEqual(whole, [
    { type: "comment", text: "hi" },
    { type: "event", event: "reply", data: "one\ntwo", id: "r1" },
    { type: "event", event: "message", data: "three" },
  ]);
  for (let i = 0; i <= text.length; i++) {
    assert.deepEqual(parseAll([text.slice(0, i), text.slice(i)]), whole, `split at ${i}`);
  }
  assert.deepEqual(parseAll([...text]), whole, "one char at a time");
});

test("CR at a chunk end followed by LF is one line end", () => {
  assert.deepEqual(parseAll(["data: a\r", "\n", "\r", "\n"]), [{ type: "event", event: "message", data: "a" }]);
  assert.deepEqual(parseAll(["data: a\r", "", "\n\r\n"]), [{ type: "event", event: "message", data: "a" }]);
});

test("comments, pings and empty data blocks dispatch nothing", () => {
  const out = parseAll([": ping\n\n", "event: reply\n\n", "id: x\n\n"]);
  assert.deepEqual(out, [{ type: "comment", text: "ping" }]);
});

test("strips a leading BOM and handles field with no colon", () => {
  assert.deepEqual(parseAll(["\ufeffdata\n\n"]), [{ type: "event", event: "message", data: "" }]);
});

test("event type resets between events", () => {
  const out = parseAll(["event: reply\ndata: 1\n\ndata: 2\n\n"]);
  assert.equal(out[0].event, "reply");
  assert.equal(out[1].event, "message");
});

test("refuses an oversized line or event", () => {
  const p = new SseParser({ maxEventBytes: 16 });
  assert.throws(() => p.push("data: " + "x".repeat(40)));
  const q = new SseParser({ maxEventBytes: 16 });
  assert.throws(() => q.push("data: 0123456789\ndata: 0123456789\n"));
});
