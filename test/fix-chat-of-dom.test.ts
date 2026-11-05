// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpsStatus } from "../src/shared/ops-status.js";
import type { Worker } from "../src/shared/workers.js";
import { setDefaultRepo } from "../src/shared/repos.js";
import { opsData } from "../web/src/ops-data.js";
import { app } from "../web/src/state.js";
import { fixChatOf, openStatus, prItem } from "../web/src/views/ops-status.js";
import { closeSheet } from "../web/src/views/sheet.js";
import { openChatSheet } from "../web/src/views/worker-sheet.js";

const REPO = "example-org/example-repo";
setDefaultRepo(REPO);

vi.mock("../web/src/views/worker-sheet.js", async (original) => ({ ...(await original<object>()), openChatSheet: vi.fn() }));

const OTHER = "example-org/other-repo";
const worker = (repo: string, chat: string): Worker => ({ id: `${repo}/${chat}`, name: chat, repo, chat, state: "working", lastOutputAt: Date.now() - 30_000 }) as Worker;
const record = (extra: Partial<OpsStatus>): OpsStatus =>
  ({ kind: "coming", key: "42", state: "investigating", chat: "fix-coming-42", since: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1, ...extra }) as OpsStatus;

afterEach(() => {
  closeSheet();
  document.body.replaceChildren();
  opsData.statuses = null;
  app.workers = null;
  app.workersAt = null;
  vi.unstubAllGlobals();
});

describe("fixChatOf", () => {
  it("never lends one repo's fix chat to another repo's item sharing its key", () => {
    app.workers = { at: new Date().toISOString(), workers: [worker(OTHER, "fix-coming-42"), worker(REPO, "fix-coming-42")] };
    opsData.statuses = [record({ repo: OTHER })];
    // The Markets record is not example-repo's row's: no chat, no worker.
    expect(fixChatOf("coming", "42", REPO)).toEqual({ chat: null, worker: null });
    expect(fixChatOf("coming", "42", OTHER.toLowerCase())).toMatchObject({ chat: "fix-coming-42", worker: { repo: OTHER } });
    // A record from before repos is read in the item's repo, as before.
    opsData.statuses = [record({})];
    expect(fixChatOf("coming", "42", REPO)).toMatchObject({ chat: "fix-coming-42", worker: { repo: REPO } });
  });
});

describe("the status sheet's Chat button", () => {
  it("opens a branch holder in the item's repo, though another repo's record names a chat of its name", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const holder = { ...worker(REPO, "lab"), branch: "mirz/lab" } as Worker;
    app.workers = { at: new Date().toISOString(), workers: [holder] };
    app.workersAt = Date.now();
    opsData.statuses = [record({ kind: "pr", key: "3788", state: "backlog", chat: "lab", repo: OTHER })];
    const item = prItem({
      repo: REPO, number: 3788, title: "PR 3788", url: `https://github.com/${REPO}/pull/3788`, draft: false, author: "mirz", labels: [], branch: "mirz/lab",
      headAt: new Date().toISOString(), updatedAt: new Date().toISOString(), checks: { state: "fail", passed: 1, failed: 1, pending: 0, failing: ["rivet"] },
    } as never)!;
    openStatus(item);
    const chat = document.querySelector<HTMLButtonElement>(".ops-status-chat");
    expect(chat?.textContent).toBe("Chat lab");
    chat!.click();
    expect(vi.mocked(openChatSheet)).toHaveBeenCalledWith("lab", REPO, "ops-status-lab", "ops", undefined);
  });
});
