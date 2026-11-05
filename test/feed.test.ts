import { describe, expect, it } from "vitest";

import type { Reply, ServedNeed } from "../src/shared/board.js";
import {
  answerKey,
  classifyFailure,
  clientIdFor,
  deckOrder,
  deskOrder,
  doneToday,
  isTap,
  laterOrder,
  needsConfirm,
  proofOf,
  localDay,
  UNDO_MS,
  UndoQueue,
  type Answer,
  type DeckInput,
} from "../web/src/feed-logic.js";

function need(id: string, rev = `r-${id}`, extra: Partial<ServedNeed> = {}): ServedNeed {
  return { id, kind: "approval", title: `Card ${id}`, rev, ...extra };
}

const EMPTY: DeckInput = { answeredRev: new Map(), reopened: new Set(), held: new Set(), later: new Map(), front: null };

class FakeTimers {
  now = 0;
  private next = 1;
  private readonly due = new Map<number, { at: number; run: () => void }>();

  set = (run: () => void, ms: number): unknown => {
    const handle = this.next++;
    this.due.set(handle, { at: this.now + ms, run });
    return handle;
  };

  clear = (handle: unknown): void => {
    this.due.delete(handle as number);
  };

  advance(ms: number): void {
    this.now += ms;
    for (const [handle, timer] of [...this.due]) {
      if (timer.at <= this.now && this.due.delete(handle)) timer.run();
    }
  }
}

describe("taps", () => {
  it("counts a press as a tap only within the slop", () => {
    expect(isTap(0, 0)).toBe(true);
    expect(isTap(6, 8)).toBe(true);
    expect(isTap(0, 11)).toBe(false);
    expect(isTap(-9, 5)).toBe(false);
  });
});

describe("deck order", () => {
  const needs = [need("a"), need("b"), need("c")];

  it("shows unanswered cards in board order", () => {
    expect(deckOrder(needs, EMPTY).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("hides a card answered at its current rev and brings it back when it changes", () => {
    const answeredRev = new Map([["a", "r-a"]]);
    expect(deckOrder(needs, { ...EMPTY, answeredRev }).map((n) => n.id)).toEqual(["b", "c"]);
    const changed = [need("a", "r-a2"), need("b"), need("c")];
    expect(deckOrder(changed, { ...EMPTY, answeredRev }).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("shows a reopened card even though it was answered", () => {
    const input = { ...EMPTY, answeredRev: new Map([["a", "r-a"]]), reopened: new Set(["a"]) };
    expect(deckOrder(needs, input).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("hides cards waiting out their undo window", () => {
    expect(deckOrder(needs, { ...EMPTY, held: new Set(["b"]) }).map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("takes cards put as Later out of the deck and lists them in the order put there", () => {
    const later = new Map([
      ["c", "r-c"],
      ["a", "r-a"],
    ]);
    expect(deckOrder(needs, { ...EMPTY, later, front: "a" }).map((n) => n.id)).toEqual(["b"]);
    expect(laterOrder(needs, { ...EMPTY, later }).map((n) => n.id)).toEqual(["c", "a"]);
  });

  it("brings a card put as Later back out at its next revision", () => {
    const later = new Map([["b", "r-b-old"]]);
    expect(deckOrder(needs, { ...EMPTY, later }).map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(laterOrder(needs, { ...EMPTY, later })).toEqual([]);
  });

  it("leaves an answered card out of Later as well as the deck", () => {
    const input = { ...EMPTY, later: new Map([["a", "r-a"]]), answeredRev: new Map([["a", "r-a"]]) };
    expect(laterOrder(needs, input)).toEqual([]);
  });

  it("brings the front card forward", () => {
    expect(deckOrder(needs, { ...EMPTY, front: "c" }).map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("ignores a front card that is not on the board", () => {
    expect(deckOrder(needs, { ...EMPTY, front: "gone" }).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });
});

describe("risk confirm", () => {
  it("asks again before approving or choosing on a risk card", () => {
    expect(needsConfirm({ risk: "money" }, "approve")).toBe(true);
    expect(needsConfirm({ risk: "auth" }, "choice")).toBe(true);
  });

  it("never blocks a reject or a comment, or an ordinary card", () => {
    expect(needsConfirm({ risk: "money" }, "reject")).toBe(false);
    expect(needsConfirm({ risk: "fairness" }, "comment")).toBe(false);
    expect(needsConfirm({}, "approve")).toBe(false);
  });
});

describe("reply ids and failures", () => {
  const answer: Answer = { itemId: "a", decision: "approve", rev: "r-a" };
  let n = 0;
  const make = () => `client-${++n}`;

  it("reuses the clientId for an identical retry and makes a new one for any change", () => {
    const first = clientIdFor(null, answer, make);
    expect(clientIdFor(first, answer, make)).toBe(first);
    expect(clientIdFor(first, { ...answer, text: "note" }, make).clientId).not.toBe(first.clientId);
    expect(clientIdFor(first, { ...answer, rev: "r-a2" }, make).clientId).not.toBe(first.clientId);
    expect(clientIdFor(first, { ...answer, decision: "reject" }, make).clientId).not.toBe(first.clientId);
  });

  it("rebuilds the key of a stored answer, so a recovered retry keeps its clientId", () => {
    const first = clientIdFor(null, { ...answer, text: "go" }, make);
    const recovered = { key: answerKey({ ...answer, text: "go" }), clientId: first.clientId };
    expect(clientIdFor(recovered, { ...answer, text: "go" }, make)).toBe(recovered);
  });

  it("classifies failed sends", () => {
    expect(classifyFailure(401)).toBe("signin");
    expect(classifyFailure(409)).toBe("changed");
    expect(classifyFailure(428)).toBe("confirm");
    expect(classifyFailure(400)).toBe("refused");
    expect(classifyFailure(403)).toBe("refused");
    expect(classifyFailure(500)).toBe("retry");
    expect(classifyFailure(0)).toBe("retry");
  });
});

describe("undo queue", () => {
  it("commits a held answer only when the undo window ends", () => {
    const timers = new FakeTimers();
    const queue = new UndoQueue<string>(UNDO_MS, timers);
    const sent: string[] = [];
    queue.push("a", (entry) => sent.push(entry));
    expect(queue.current).toBe("a");
    timers.advance(UNDO_MS - 1);
    expect(sent).toEqual([]);
    timers.advance(1);
    expect(sent).toEqual(["a"]);
    expect(queue.current).toBeNull();
  });

  it("never sends an undone answer", () => {
    const timers = new FakeTimers();
    const queue = new UndoQueue<string>(UNDO_MS, timers);
    const sent: string[] = [];
    queue.push("a", (entry) => sent.push(entry));
    expect(queue.undo()).toBe("a");
    timers.advance(UNDO_MS * 2);
    expect(sent).toEqual([]);
    expect(queue.undo()).toBeNull();
  });

  it("a new answer never shortens an earlier one's window, and Undo takes back the newest", () => {
    const timers = new FakeTimers();
    const queue = new UndoQueue<string>(UNDO_MS, timers);
    const sent: string[] = [];
    queue.push("a", (entry) => sent.push(entry));
    timers.advance(1_000);
    queue.push("b", (entry) => sent.push(entry));
    queue.push("c", (entry) => sent.push(entry));
    expect(sent).toEqual([]);
    expect(queue.current).toBe("c");
    expect(queue.undo()).toBe("c");
    expect(queue.current).toBe("b");
    timers.advance(UNDO_MS - 1_001);
    expect(sent).toEqual([]);
    timers.advance(1);
    expect(sent).toEqual(["a"]);
    expect(queue.current).toBe("b");
    timers.advance(1_000);
    expect(sent).toEqual(["a", "b"]);
    expect(queue.current).toBeNull();
  });

  it("drains every held answer without sending it", () => {
    const timers = new FakeTimers();
    const queue = new UndoQueue<string>(UNDO_MS, timers);
    const sent: string[] = [];
    queue.push("a", (entry) => sent.push(entry));
    queue.push("b", (entry) => sent.push(entry));
    expect(queue.drain()).toEqual(["a", "b"]);
    timers.advance(UNDO_MS * 2);
    queue.flush();
    expect(sent).toEqual([]);
  });

  it("flushes every held answer once, oldest first, for a page going away", () => {
    const timers = new FakeTimers();
    const queue = new UndoQueue<string>(UNDO_MS, timers);
    const sent: string[] = [];
    queue.push("a", (entry) => sent.push(entry));
    queue.push("b", (entry) => sent.push(entry));
    queue.flush();
    queue.flush();
    timers.advance(UNDO_MS);
    expect(sent).toEqual(["a", "b"]);
  });
});

describe("the desktop board's order", () => {
  it("puts risky cards first, then the oldest", () => {
    const cards = [
      need("new", "r", { since: "2026-09-30T10:00:00.000Z" }),
      need("old", "r", { since: "2026-09-30T08:00:00.000Z" }),
      need("undated"),
      need("money", "r", { since: "2026-09-30T11:00:00.000Z", risk: "money" }),
      need("auth", "r", { risk: "auth" }),
    ];
    expect(deskOrder(cards).map((n) => n.id)).toEqual(["money", "auth", "old", "new", "undated"]);
  });

  it("keeps the board's order between cards that tie", () => {
    expect(deskOrder([need("b"), need("a"), need("c")]).map((n) => n.id)).toEqual(["b", "a", "c"]);
  });
});


describe("Feed › Done", () => {
  const reply = (id: string, at: string, decision: Reply["decision"] = "approve"): Reply =>
    ({ id: `r-${id}`, itemId: id, itemTitle: `Card ${id}`, decision, rev: "0".repeat(16), at, handled: true }) as Reply;

  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();

  it("reads the day in the phone's own time zone", () => {
    expect(localDay(new Date(2026, 9, 11, 0, 30))).toBe("2026-10-11");
    expect(localDay(new Date(2026, 9, 10, 23, 30))).toBe("2026-10-10");
    expect(localDay("not a time")).toBe("");
  });

  it("lists today's answers newest first, with the updates seen today apart", () => {
    const now = new Date(2026, 9, 11, 12, 0);
    const { answered, seen } = doneToday(
      [
        reply("yesterday", at(10, 22)),
        reply("early", at(11, 1), "reject"),
        reply("late", at(11, 11, 30), "choice"),
        reply("news", at(11, 11, 10), "seen"),
        reply("broken", "not a time"),
      ],
      now,
    );
    expect(answered.map((r) => r.itemId)).toEqual(["late", "early"]);
    expect(seen.map((r) => r.itemId)).toEqual(["news"]);
  });
});

describe("proofOf", () => {
  const merge = need("m", "r-m", { kind: "merge-ready", pr: 12 });
  const texts = (lines: ReturnType<typeof proofOf>) => lines.map((line) => `${line.tone}:${line.text}`);

  it("says when nothing holds a merge", () => {
    expect(texts(proofOf(merge))).toEqual(["ok:Nothing holds it"]);
  });

  it("lists what the chat wrote, and every hold", () => {
    const card = {
      ...merge,
      evidence: { ci: "green", ciNote: "gate clean on abc1234", review: "findings", reviewNote: "1 open", why: "It changes the Feed", holding: ["owner video"] },
    } as ServedNeed;
    expect(texts(proofOf(card))).toEqual([
      "ok:Tests green · gate clean on abc1234",
      "bad:Review: findings open · 1 open",
      "ok:Why you: It changes the Feed",
      "warn:Held: owner video",
    ]);
  });

  it("gives no proof to a card that is neither merge-ready nor carries any", () => {
    expect(proofOf(need("a"))).toEqual([]);
});
});
