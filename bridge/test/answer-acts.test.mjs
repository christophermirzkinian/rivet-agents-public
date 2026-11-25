import assert from "node:assert/strict";
import { test } from "node:test";
import { mayActByCode, UNMARKED_ANSWERS_UNTIL } from "../lib/answer-acts.mjs";
import { validateReply } from "../lib/validate.mjs";
import { reply } from "./fixtures.mjs";

const AFTER = UNMARKED_ANSWERS_UNTIL;
const BEFORE = new Date(Date.parse(UNMARKED_ANSWERS_UNTIL) - 1).toISOString();

test("an answer the server marked may act, whenever it was given", () => {
  for (const at of [BEFORE, AFTER, "2030-01-01T00:00:00.000Z", undefined, "not a time"]) assert.equal(mayActByCode({ at, item: { passkey: true } }), true, String(at));
});

test("an answer with no mark may act only when the server stored it before the cut-off", () => {
  assert.equal(mayActByCode({ at: BEFORE, item: { id: "card-1" } }), true);
  assert.equal(mayActByCode({ at: BEFORE }), true);
  for (const at of [AFTER, "2030-01-01T00:00:00.000Z", undefined, null, 0, "", "not a time"]) {
    assert.equal(mayActByCode(/** @type {any} */ ({ at, item: { id: "card-1" } })), false, String(at));
  }
  assert.equal(mayActByCode(undefined), false);
  assert.equal(mayActByCode(null), false);
});

test("a mark that is not true never acts, even before the cut-off", () => {
  for (const passkey of [false, "true", 1, null]) assert.equal(mayActByCode({ at: BEFORE, item: { passkey } }), false, String(passkey));
});

test("an answer a device code made never acts, at any date, whatever else it carries", () => {
  for (const at of [BEFORE, AFTER, "2020-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z"]) {
    assert.equal(mayActByCode({ at, item: { via: "device-code" } }), false, at);
    assert.equal(mayActByCode({ at, item: { via: "device-code", passkey: true } }), false, `both marks, ${at}`);
    for (const via of ["passkey", "", null, 0]) assert.equal(mayActByCode({ at, item: { via, passkey: true } }), false, `${String(via)}, ${at}`);
  }
});

test("the bridge's own reading of an answer keeps a device code's mark, and reads any value of it as one", () => {
  const read = (/** @type {any} */ item) => /** @type {any} */ (validateReply(reply({ at: BEFORE }, item))).reply;
  for (const via of ["device-code", "passkey", "", 0, false, null]) {
    assert.equal(read({ via })?.item?.via, "device-code", String(via));
    assert.equal(mayActByCode(read({ via })), false, String(via));
  }
  assert.equal(mayActByCode(read({ via: "device-code", passkey: true })), false);
  assert.equal(mayActByCode(read({ via: null, passkey: true })), false);
  assert.equal("via" in read({ via: undefined }).item, false);
});

test("the bridge's own reading of an answer keeps the server's mark; any other value stays a refused one, even before the cut-off", () => {
  const read = (/** @type {any} */ item) => /** @type {any} */ (validateReply(reply({ at: BEFORE }, item))).reply;
  assert.equal(read({ passkey: true })?.item?.passkey, true);
  assert.equal(mayActByCode(read({ passkey: true })), true);
  for (const passkey of [false, "true", 1, null]) {
    assert.equal(read({ passkey })?.item?.passkey, false, String(passkey));
    assert.equal(mayActByCode(read({ passkey })), false, String(passkey));
  }
  assert.equal("passkey" in read({ passkey: undefined }).item, false);
  assert.equal(mayActByCode(read({})), true);
});
