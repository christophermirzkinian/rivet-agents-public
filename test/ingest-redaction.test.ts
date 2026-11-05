import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PushSender } from "../src/server/push.js";
import { BOARD_MEDIA, redactBody, redactId, redactText, redactUrl, SAY_MEDIA } from "../src/server/redact.js";
import type { PushSubscriptionRow } from "../src/server/store.js";
import { bearer, BOARD_TOKEN, browser, EXAMPLE_BOARD, putBoard, startServer, type TestServer } from "./helpers.js";

// Made-up secret shapes only, built at run time so no token shape sits in the source.
const GH = "gh" + "p_" + "Zq9".repeat(12);
const PASSWORD = "qzvtkfakepass";
const FAKES = [GH, PASSWORD];
const leaked = (text: string) => FAKES.filter((fake) => text.includes(fake));

describe("redactText", () => {
  it("keeps text the redactor finds nothing in as written, indents and tabs included", () => {
    for (const text of ["- a\n  - nested\n\tcode", "Merged #712 → deployed ✅ https://github.com/x/y/pull/712", "2026-10-28T01:02:03.000Z", "pr2022-checkout", "line one  \r\nline two"])
      expect(redactText(text)).toBe(text);
  });

  it("redacts a token or a password, never longer than it was", () => {
    for (const text of [`gh api -H 'Authorization: Bearer ${GH}' /user failed`, `- step\n  DB password: ${PASSWORD}\n- next`, `token ${GH}`]) {
      const out = redactText(text);
      expect(leaked(out)).toEqual([]);
      expect(out.length).toBeLessThanOrEqual(text.length);
      expect(redactText(out)).toBe(out);
    }
  });

  it("never keeps text an escape sequence or a control character hides a secret in", () => {
    for (const text of [`ok\u001b]0;${GH}\u0007`, `\u001b]0;password: ${PASSWORD}\u0007Ready`, `a\u0000${GH}`]) expect(leaked(redactText(text))).toEqual([]);
  });

  it("redacts a string under a key that names a secret, and not one under author or auth-like words", () => {
    expect(redactBody({ extra: { password: PASSWORD, apiKey: "qzvtkfake", db_token: "qzvtkfake", PGPASSWORD: PASSWORD, credentials: { primary: PASSWORD }, author: "Rivet", authored: "today" } })).toEqual({
      extra: { password: "[redacted]", apiKey: "[redacted]", db_token: "[redacted]", PGPASSWORD: "[redacted]", credentials: "[redacted]", author: "Rivet", authored: "today" },
    });
  });

  it("keeps a tool call's or client's opaque id and refuses one shaped as a credential", () => {
    const toolId = `toolu_01${"Qx9".repeat(7)}`;
    expect(redactBody({ id: toolId, clientId: toolId })).toEqual({ id: toolId, clientId: toolId });
    expect(redactId(GH)).not.toBe(GH);
    expect(leaked(redactId(`x_${GH}`))).toEqual([]);
    expect(leaked(redactBody({ id: `x ${GH}` }).id)).toEqual([]);
    const aws = `X_AKIA${"ABCDEFGHIJKLMNOP"}`;
    const sk = `xsk-${"qz9v".repeat(4)}`;
    expect(redactId(aws)).toBe("[redacted]");
    expect(redactId(`x-${sk.slice(1)}`)).toBe("[redacted]");
    expect(redactId(sk)).toBe(sk);
    const task = `task-${["0a1b2c3d", "0a1b", "4a1b", "8a1b", "0a1b2c3d4e5f"].join("-")}`;
    expect(redactId(task)).toBe(task);
    const hashed = `card.${"0123456789abcdef".repeat(2)}`;
    expect(redactId(hashed)).toBe(hashed);
  });

  it("redacts a secret-named object whole, the names of its entries included", () => {
    expect(redactBody({ extra: { tokens: { [PASSWORD]: "read" }, secrets: {} } })).toEqual({ extra: { tokens: "[redacted]", secrets: {} } });
  });

  it("drops an entry whose key holds a secret and keeps everything else", () => {
    expect(redactBody({ title: `see ${GH}`, n: 3, ok: true, none: null, list: ["fine", `password: ${PASSWORD}`], [GH]: "x" })).toEqual({
      title: expect.not.stringContaining(GH),
      n: 3,
      ok: true,
      none: null,
      list: ["fine", expect.not.stringContaining(PASSWORD)],
    });
  });
});

describe("redactUrl", () => {
  it("keeps a shared file's id in a link's path and drops a secret in its query or user", () => {
    const shared = "https://files.example.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view";
    expect(redactUrl(shared)).toBe(shared);
    expect(redactUrl(`https://h.example/p?access_token=${GH}#x`)).toBe("https://h.example/p");
    expect(redactUrl(`https://bot:${PASSWORD}@h.example/p?page=2`)).toBe("https://h.example/p?page=2");
    expect(leaked(redactUrl(`not a url ${GH}`))).toEqual([]);
    expect(leaked(redactUrl(`https://h.example/${GH}/x`))).toEqual([]);
    expect(leaked(redactUrl(`https://h.example/%67hp_${"Zq9".repeat(12)}`))).toEqual([]);
    expect(redactUrl(`https://h.example/?%70assword=${PASSWORD}`)).toBe("https://h.example/");
    expect(leaked(redactUrl(`https://h.example/password=${PASSWORD}`))).toEqual([]);
    expect(leaked(redactUrl(`https://h.example/%E2%84%A2/${GH}`))).toEqual([]);
    expect(leaked(redactUrl(`https://${GH}.example/p`))).toEqual([]);
    const google = `AIza${"Zq9".repeat(10)}`;
    expect(redactUrl(`https://${google}.example/p`)).toBe("[redacted]");
    expect(redactUrl(`https://bot@${google}.example:8443/p`)).toBe("[redacted]");
    expect(redactUrl(` https://${google}.example/p`)).toBe("[redacted]");
    expect(redactUrl(`https://AI\tza${"Zq9".repeat(10)}.example/p`)).toBe("[redacted]");
    expect(leaked(redactUrl(`https://h.example/X_AKIA${"ABCDEFGHIJKLMNOP"}`))).toEqual([]);
    expect(redactUrl(`https://h.example/X_AKIA${"ABCDEFGHIJKLMNOP"}`)).not.toContain("AKIA");
    const longPart = `${"G".repeat(93)}_sk-${"Q".repeat(32)}`;
    expect(redactUrl(`https://h.example/${longPart}`)).toBe("https://h.example/");
    expect(redactId(longPart)).toBe("[redacted]");
    const started = performance.now();
    expect(redactId(`${"_eyJ".repeat(50000)}.AAAAAA`)).toBe("[redacted]");
    expect(redactUrl(`https://h.example/${"_eyJ".repeat(50000)}.AAAAAA`)).toBe("https://h.example/");
    expect(performance.now() - started).toBeLessThan(500);
    expect(redactId("a".repeat(257))).toBe("[redacted]");
    expect(redactUrl(`https://eyJ${"A".repeat(6)}.${"B".repeat(6)}.${"C".repeat(6)}.example/p`)).toBe("[redacted]");
    const digestFile = `https://h.example/${"0123456789abcdef".repeat(2)}.pdf`;
    expect(redactUrl(digestFile)).toBe(digestFile);
    expect(redactUrl("https://user:pw@Example.COM:8080/a")).toBe("https://example.com:8080/a");
    expect(redactUrl(`https://h.example/?a=1&password=${PASSWORD}`)).toBe("https://h.example/");
    expect(redactUrl("https://github.com/example-org/example-repo/pull/6717?tab=files#diff")).toBe("https://github.com/example-org/example-repo/pull/6717?tab=files#diff");
  });

  it("keeps a media digest where a file is named by one, and nowhere else", () => {
    const sha = "0123456789abcdef".repeat(4);
    const card = { media: { stills: [{ sha256: sha }] }, links: [{ url: "https://claude.ai/artifact/3A1f6kW19m6k6umKNLN" }] };
    expect(redactBody({ needs: [card] }, BOARD_MEDIA)).toEqual({ needs: [card] });
    expect(redactBody({ images: [sha], video: sha }, SAY_MEDIA)).toEqual({ images: [sha], video: sha });
    expect(redactBody({ text: sha }).text).not.toBe(sha);
    // Only where the route checks a media file is named: not under a board's unknown field, nor a say's nested one.
    for (const [body, media] of [[{ images: [sha], video: sha, extra: { media: { sha256: sha } } }, BOARD_MEDIA], [{ extra: { video: sha } }, SAY_MEDIA]] as const)
      expect(JSON.stringify(redactBody(body, media))).not.toContain(sha);
  });
});

class FakeSender implements PushSender {
  readonly payloads: string[] = [];
  async send(_target: PushSubscriptionRow, payload: string): Promise<number> {
    this.payloads.push(payload);
    return 201;
  }
}

describe("what the board token writes is stored and pushed redacted", () => {
  let server: TestServer;
  let sender: FakeSender;
  let cookie: string;

  beforeEach(async () => {
    sender = new FakeSender();
    server = await startServer({ RIVET_VAPID_PUBLIC_KEY: "BPublicKeyForTests", RIVET_VAPID_PRIVATE_KEY: "private-key-for-tests", RIVET_VAPID_SUBJECT: "mailto:ops@example.com" }, { pushSender: sender });
    cookie = server.cookie();
    await fetch(`${server.base}/api/push/subscribe`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/device-1", keys: { p256dh: "BKey1", auth: "auth1" } }),
    });
  });

  afterEach(async () => {
    await server.close();
  });

  const post = (path: string, body: unknown) => fetch(`${server.base}${path}`, { method: "POST", headers: bearer(BOARD_TOKEN), body: JSON.stringify(body) });

  /** Every byte of the server's data folder (the SQLite file and its log), read as text. */
  const stored = () =>
    readdirSync(server.dataDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1"))
      .join("\n");

  it("redacts card, say and comment text before it is stored, shown or pushed", async () => {
    const card = { id: "leaky-card", kind: "decision", title: `deploy failed: token ${GH}`, ask: `Ran:\n  gh api -H 'Authorization: Bearer ${GH}'\nDB password: ${PASSWORD}`, options: [{ label: "Ship it" }] };
    const update = { id: "leaky-update", kind: "update", title: "Merged", tag: "Merged", ask: `password: ${PASSWORD}` };
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [...EXAMPLE_BOARD.needs, card, update] })).status).toBe(200);
    // Comments go under an update card stored before the server took new ones as Got it cards (2026-11-01).
    const before = server.app.store.getBoard()!;
    expect(server.app.store.putBoard({ ...before.board, needs: [...before.board.needs, { id: "old-update", kind: "update", title: "Merged", thread: "main" }] }, before.version)).toBeTruthy();
    expect((await fetch(`${server.base}/api/board/needs/leaky-item`, { method: "PUT", headers: bearer(BOARD_TOKEN), body: JSON.stringify({ kind: "decision", title: `item ${GH}` }) })).status).toBe(200);
    expect((await post("/api/bridge/say", { text: `the deploy said: password: ${PASSWORD}` })).status).toBe(201);
    expect((await post("/api/board/needs/old-update/comments", { text: `the key was ${GH}` })).status).toBe(201);

    const board = await (await fetch(`${server.base}/api/board`, { headers: { cookie } })).text();
    expect(board).toContain("leaky-card");
    expect(board).toContain("Watch the video and approve or send changes.");
    // A say replying to nothing is a Got it card.
    expect(board).toContain("the deploy said");
    for (const text of [board, ...sender.payloads, stored()]) expect(leaked(text)).toEqual([]);
    expect(sender.payloads.length).toBeGreaterThan(0);
  });

  it("redacts the ask text an agent writes", async () => {
    expect((await post("/api/asks", { id: "a-1", words: "Cache keys: never forgotten", stage: "needs-you", note: `tried ${GH}` })).status).toBe(201);
    expect(leaked(stored())).toEqual([]);
  });

  it("refuses a card whose options redaction would make read the same", async () => {
    const card = { id: "session-policy", kind: "decision", title: "Choose session expiry", options: [{ label: "Session: expire after one hour" }, { label: "Session: expire after six hours" }] };
    const response = await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [...EXAMPLE_BOARD.needs, card] });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("two options read the same");
  });

  it("refuses a secret in an id-like field instead of storing it", async () => {
    expect((await post("/api/bridge/say", { text: "hi", replyTo: GH })).status).toBe(400);
    expect(leaked(stored())).toEqual([]);
  });
});
