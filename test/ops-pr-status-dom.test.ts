// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { NEEDS_YOU } from "../src/shared/words.js";

import type { Reply, ServedNeed } from "../src/shared/board.js";
import type { PullRequest } from "../src/shared/ops.js";
import { setDefaultRepo } from "../src/shared/repos.js";
import { app } from "../web/src/state.js";
import { prStatus } from "../web/src/views/ops.js";

const REPO = "example-org/example-repo";
setDefaultRepo(REPO);

const headSha = "a".repeat(40);
const pr = (extra: Partial<PullRequest> = {}): PullRequest => ({
  repo: REPO, number: 42, title: "Example", url: `https://github.com/${REPO}/pull/42`,
  draft: false, author: "mirz", labels: [], headAt: null, updatedAt: "2026-10-08T00:00:00Z", headSha,
  checks: { state: "pass", passed: 1, failed: 0, pending: 0, failing: [] }, ...extra,
});
const need = (extra: Partial<ServedNeed> = {}): ServedNeed => ({
  id: "approval", kind: "approval", title: "Review the design", ask: "OK?", options: [],
  rev: "a".repeat(16), pr: 42, ...extra,
} as ServedNeed);
function cards(...needs: ServedNeed[]) {
  app.board = { version: 1, updatedAt: "2026-10-08T00:00:00Z", board: {
    updatedAt: "2026-10-08T00:00:00Z", needs, coming: [], chats: [], shipped: [],
  } } as typeof app.board;
}

afterEach(() => {
  app.board = null;
  app.replies.clear();
  app.held.clear();
  app.later.clear();
  app.reopened.clear();
});

describe("Ops PRs wait on an answerable card", () => {
  it("shows holds without assigning you an answer that has no card", () => {
    expect(prStatus(pr({ hold: "Owner hold: the owner reviews the design" }))).toEqual({ tag: "On hold: the owner reviews the design", tone: "warn", eta: null });
    expect(prStatus(pr({ labels: ["owner-hold"] })).tag).toMatch(/^On hold/);
    expect(prStatus(pr({ hold: "**Merge waits for your OK on the design.**" })).tag).toMatch(/^On hold/);
    app.board = null;
  });

  it("accepts a matching approval and preserves holds without promising a merge", () => {
    cards(need());
    expect(prStatus(pr())).toEqual({ tag: NEEDS_YOU, tone: "warn", eta: null });
    expect(prStatus(pr({ hold: "Owner hold: awaiting review" }))).toEqual({ tag: NEEDS_YOU, tone: "warn", eta: "On hold: awaiting review" });
    cards(need({ kind: "merge-ready", headSha }));
    expect(prStatus(pr()).eta).toBe("Merges when you tap");
    expect(prStatus(pr({ hold: "Hold: another PR first" })).eta).toBe("On hold: another PR first");
  });

  it("matches the PR, repository and current merge-ready head", () => {
    for (const card of [
      need({ pr: 43 }), need({ pr: undefined }), need({ repo: "example-org/other-repo" }),
      need({ kind: "merge-ready", headSha: "b".repeat(40) }), need({ kind: "update" }),
    ]) {
      cards(card);
      expect(prStatus(pr({ hold: "Owner hold: awaiting review" })).tag).toBe("On hold: awaiting review");
    }
    cards(need({ kind: "merge-ready", headSha }));
    expect(prStatus(pr({ headSha: undefined })).tag).toBe("Checks green");
    cards(need({ repo: "example-org/other-repo" }));
    expect(prStatus(pr({ repo: "example-org/other-repo" })).tag).toBe(NEEDS_YOU);
    cards(need());
    expect(prStatus(pr({ repo: "example-org/other-repo" })).tag).toBe("Checks green");
  });

  it("excludes answered cards and those awaiting send, and accepts a newly revised card", () => {
    const card = need();
    cards(card);
    app.replies.set(card.id, { rev: card.rev } as Reply);
    expect(prStatus(pr()).tag).toBe("Checks green");
    cards(need({ rev: "b".repeat(16) }));
    expect(prStatus(pr()).tag).toBe(NEEDS_YOU);
    app.held.add(card.id);
    expect(prStatus(pr()).tag).toBe("Checks green");
  });

  it("preserves stale-data, draft and failing-check precedence", () => {
    cards(need());
    expect(prStatus(pr(), undefined, false).tag).toContain("no current reading");
    expect(prStatus(pr({ hold: "Owner hold: awaiting review" }), undefined, false).tag).toContain("no current reading");
    expect(prStatus(pr({ draft: true })).tag).toBe("Draft");
    expect(prStatus(pr({ checks: { state: "fail", passed: 0, failed: 1, pending: 0, failing: ["unit"] } })).tag).toBe("Red: not picked up");
  });
});
