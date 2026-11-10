import { describe, expect, it } from "vitest";

import type { UsageCell } from "../src/shared/ops.js";
import { asLimits, machinesHead, machinesWorstFirst, usageLead } from "../web/src/reading-figures.js";

// The figure each reading page leads with: Usage's "left" and Machines' "need a look", apart from the DOM.

const cell = (percent: number, unread = false): UsageCell => ({ who: "ab***", percent, unread, active: false, resetsAt: null, window: "week", rows: [] });
const read = (...tones: string[]) => tones.map((tone) => ({ tone, read: true }));

describe("Usage's lead", () => {
  it("says what is left of every account's limit, with the used and unread line", () => {
    const lead = usageLead([cell(100), cell(100), cell(100), cell(70), cell(0, true)], false)!;
    expect([lead.left, lead.of, lead.used]).toEqual(["0.3", "5", "3.7"]);
    expect(lead.line).toBe("3.7 used · 1 account not read · 3 accounts full");
    expect(lead.tone).toBe("bad");
  });

  it("is green over 25% left, gold from 10% and red under 10%", () => {
    expect(usageLead([cell(50), cell(20)], false)!.tone).toBe("ok");
    expect(usageLead([cell(75), cell(75)], false)!.tone).toBe("warn");
    expect(usageLead([cell(90), cell(90)], false)!.tone).toBe("warn");
    expect(usageLead([cell(95), cell(91)], false)!.tone).toBe("bad");
    // 90.4% used is 9.6% left: red, though both read 10% once rounded.
    const near = usageLead([cell(90.4)], false)!;
    expect([near.tone, near.used, near.left]).toEqual(["bad", "0.9", "0.1"]);
  });

  it("puts a green figure on a gold card when an account is 90% full or the reading is old", () => {
    const full = usageLead([cell(90), cell(0), cell(0)], false)!;
    expect([full.tone, full.cardTone, full.full, full.line]).toEqual(["ok", "warn", 1, "0.9 used · 1 account full"]);
    const old = usageLead([cell(10)], true)!;
    expect([old.tone, old.cardTone]).toEqual(["ok", "warn"]);
    expect(usageLead([cell(10)], false)!.cardTone).toBe("ok");
  });

  it("is nothing while no account was read", () => {
    expect(usageLead([], false)).toBeNull();
    expect(usageLead([cell(0, true)], false)).toBeNull();
  });

  it("reads hundreds of percent as limits", () => {
    expect([asLimits(368), asLimits(300), asLimits(30)]).toEqual(["3.7", "3", "0.3"]);
  });
});

describe("Machines' lead", () => {
  it("counts the machines that need a look, red over amber", () => {
    expect(machinesHead(read("ok", "bad", "warn", "ok", "ok"))).toEqual({ figure: "2", words: "of 5 need a look", tone: "bad" });
    expect(machinesHead(read("ok", "warn", "ok"))).toEqual({ figure: "1", words: "of 3 needs a look", tone: "warn" });
  });

  it("says all working only when every machine was read fine", () => {
    expect(machinesHead(read("ok", "ok", "ok", "ok", "ok"))).toEqual({ figure: "All", words: "5 working", tone: "ok" });
    expect(machinesHead([{ tone: "ok", read: true }, { tone: "info", read: false }])).toEqual({ figure: "1", words: "of 2 not read yet", tone: "idle" });
  });


  it("never counts a machine whose fault the owner dismissed as working: calm, but not all working", () => {
    const four = read("ok", "ok", "ok", "ok");
    expect(machinesHead([...four, { tone: "idle", read: true, fault: true }])).toEqual({ figure: "4", words: "of 5 working", tone: "idle" });
    expect(machinesHead([...four, { tone: "idle", read: true, fault: false }])).toEqual({ figure: "All", words: "5 working", tone: "ok" });
    // One that needs a look still leads.
    expect(machinesHead([...read("bad", "ok"), { tone: "idle", read: true, fault: true }])).toEqual({ figure: "1", words: "of 3 needs a look", tone: "bad" });
  });

  it("sorts red, then amber, then not read, then green, keeping each tone's order", () => {
    const rows = [
      { name: "a", tone: "ok" },
      { name: "b", tone: "warn" },
      { name: "c", tone: "idle" },
      { name: "d", tone: "bad" },
      { name: "e", tone: "ok" },
      { name: "f", tone: "bad" },
    ];
    expect(machinesWorstFirst(rows).map((row) => row.name)).toEqual(["d", "f", "b", "c", "a", "e"]);
  });
});
