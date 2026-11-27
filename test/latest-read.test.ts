import { describe, expect, it } from "vitest";
import { latestRead } from "../web/src/latest-read.js";

describe("latest started read", () => {
  it("keeps the newer result when two reads resolve in reverse order", async () => {
    const reads = latestRead();
    let shown = "";
    let first!: (value: string) => void;
    let second!: (value: string) => void;
    const apply = async (answer: Promise<string>) => {
      const latest = reads.start();
      const next = await answer;
      if (latest()) shown = next;
    };
    const older = apply(new Promise((resolve) => { first = resolve; }));
    const newer = apply(new Promise((resolve) => { second = resolve; }));
    second("newer");
    await newer;
    first("older");
    await older;
    expect(shown).toBe("newer");
  });

  it("supersedes a read as soon as the next starts, even before either settles", () => {
    const reads = latestRead();
    const first = reads.start();
    const second = reads.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("invalidates pending reads on a write or close without rejecting later reads", () => {
    const reads = latestRead();
    const pending = reads.start();
    reads.invalidate();
    expect(pending()).toBe(false);
    const next = reads.start();
    expect(next()).toBe(true);
    expect(pending()).toBe(false);
  });

  it("keeps independent loaders separate", () => {
    const first = latestRead();
    const second = latestRead();
    const pending = first.start();
    second.start();
    second.invalidate();
    expect(pending()).toBe(true);
  });
});
