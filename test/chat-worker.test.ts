import { describe, expect, it } from "vitest";

import { chatGone, chatWorker } from "../src/shared/summary.js";
import type { Worker } from "../src/shared/workers.js";

const MARKETS = "example-org/third-repo";
const worker = (repo: string, chat: string) => ({ repo, chat, state: "working" }) as unknown as Worker;

describe("chatWorker", () => {
  const markets = worker(MARKETS, "lab");

  it("reads a row naming no repo as the one chat of its name in a repo with no row of that name", () => {
    expect(chatWorker({ name: "lab" }, [markets])).toBe(markets);
    expect(chatWorker({ name: "lab" }, [markets], [{ name: "lab" }])).toBe(markets);
  });

  it("never as another repo's chat that repo has a row for", () => {
    const chats = [{ name: "lab" }, { name: "lab", repo: MARKETS }];
    expect(chatWorker({ name: "lab" }, [markets], chats)).toBeUndefined();
    expect(chatGone({ name: "lab" }, { workers: [markets], lapsed: false }, chats)).toBe(true);
    expect(chatWorker({ name: "lab", repo: MARKETS }, [markets], chats)).toBe(markets);
  });
});
