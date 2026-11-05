import { afterEach, describe, expect, it } from "vitest";

import { needRev } from "../src/server/http.js";
import { cardPayload, KIND_LEVELS, needLevel, pushButtons, type PushSender } from "../src/server/push.js";
import { needSchema, type Need } from "../src/shared/board.js";
import { browser, EXAMPLE_BOARD, putBoard, startServer, type TestServer } from "./helpers.js";

// The buttons on a card's push: Yes / No / Later, pinned to the card's rev.

const need = (id: string, extra: Partial<Need> = {}): Need => needSchema.parse({ id, kind: "decision", title: `Card ${id}`, ...extra });
const BUTTONS = [
  { action: "yes", title: "Yes" },
  { action: "no", title: "No" },
  { action: "later", title: "Later" },
];

describe("a card's push buttons", () => {
  it("carry Yes / No / Later and the card's rev on a yes-or-no card", () => {
    const card = need("c1");
    expect(cardPayload(card)).toMatchObject({
      card: "c1",
      rev: needRev(card),
      actions: BUTTONS,
      // No has no answer: it opens the card, since a reject always asks why first.
      answers: { yes: { decision: "approve" } },
    });
    expect(cardPayload(card).answers).not.toHaveProperty("no");
  });

  it("say Yes on a merge-ready card", () => {
    const card = need("m1", { kind: "merge-ready", pr: 12, headSha: "a".repeat(40) });
    expect(cardPayload(card).actions?.[0]).toEqual({ action: "yes", title: "Yes" });
  });

  it("pick the Yes and No options on an ask", () => {
    const card = need("ask-0123abcd", { kind: "ask", ask: "Ready to go?", options: [{ label: "Yes" }, { label: "No" }] });
    expect(pushButtons(card)).toEqual({
      actions: BUTTONS,
      answers: { yes: { decision: "choice", choice: "Yes" }, no: { decision: "choice", choice: "No" } },
    });
    expect(needLevel(card)).toBe("needs-you");
    expect(KIND_LEVELS.get("ask")).toBe("needs-you");
  });

  it("are Seen alone on an update card", () => {
    const card = need("u1", { kind: "update", tag: "Merged", thread: "Docs Sync" });
    expect(cardPayload(card)).toMatchObject({ rev: needRev(card), actions: [{ action: "seen", title: "Seen" }], answers: { seen: { decision: "seen" } } });
  });

  it("are left off where one tap must not answer: risk, todo, typed answers and other option cards", () => {
    const none = [
      need("r1", { risk: "money" }),
      need("t1", { kind: "todo", steps: ["Do it"] }),
      need("q1", { kind: "question" }),
      need("x1", { reply: "text" }),
      need("o1", { options: [{ label: "Blue" }, { label: "Red" }] }),
      need("o2", { options: [{ label: "Yes", text: true }, { label: "No" }] }),
      // An outcome card: its Yes, keep it is not a bare Yes, so it opens the card as before.
      need("o4", { options: [{ label: "Yes, keep it" }, { label: "Change it", text: true }] }),
    ];
    for (const card of none) {
      const payload = cardPayload(card);
      expect(payload.actions, card.id).toBeUndefined();
      expect(payload.answers, card.id).toBeUndefined();
      expect(payload.rev).toBe(needRev(card));
    }
  });

  it("open the card on No when a Yes option card has no No option, so the reject asks why", () => {
    expect(pushButtons(need("o3", { options: [{ label: "yes" }, { label: "Later this week" }] })).answers).toEqual({
      yes: { decision: "choice", choice: "yes" },
    });
  });
});

describe("a button's answer at the server", () => {
  let server: TestServer;
  afterEach(async () => server.close());

  it("lands with the push's rev, and a late tap after the card changed is refused (409)", async () => {
    const sent: Record<string, unknown>[] = [];
    const sender: PushSender = { send: async (_target, payload) => (sent.push(JSON.parse(payload) as Record<string, unknown>), 201) };
    server = await startServer(
      { RIVET_VAPID_PUBLIC_KEY: "BPublicKeyForTests", RIVET_VAPID_PRIVATE_KEY: "private-key-for-tests", RIVET_VAPID_SUBJECT: "mailto:ops@example.com" },
      { pushSender: sender },
    );
    server.app.store.addPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/device-1", keys: { p256dh: "BKey1", auth: "auth1" } });
    const cookie = server.cookie();
    const cards = [
      { id: "c1", kind: "decision", title: "Ship it?" },
      { id: "c2", kind: "decision", title: "Turn it on?" },
    ];
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, needs: cards })).status).toBe(200);
    for (let i = 0; i < 50 && sent.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const pushed = (id: string) => sent.find((payload) => payload.card === id) as { rev: string; answers: { yes: { decision: string } } };
    const answer = (id: string, clientId: string) =>
      fetch(`${server.base}/api/replies`, {
        method: "POST",
        headers: browser(cookie),
        body: JSON.stringify({ clientId, itemId: id, decision: pushed(id).answers.yes.decision, rev: pushed(id).rev }),
      });

    expect((await answer("c1", "push-tap-0001")).status).toBe(201);
    expect((await putBoard(server.base, { ...EXAMPLE_BOARD, needs: [cards[0], { ...cards[1], title: "Turn it on tonight?" }] })).status).toBe(200);
    expect((await answer("c2", "push-tap-0002")).status).toBe(409);
  });
});
