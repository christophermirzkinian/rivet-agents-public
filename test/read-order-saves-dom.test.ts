// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../src/shared/command.js";
import type { Job, JobsResponse } from "../src/shared/jobs.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const job = (name: string, state: Job["state"] = "active"): Job => ({
  id: "j-aaaaaaaa", name, state, words: "Check the app", kind: "check",
  check: { probe: "up", app: "notes-app", where: "mac", onRed: "card" },
  when: { every: "day", at: "07:00" }, cards: "red", createdAt: "2026-11-01T00:00:00.000Z", activeSince: "2026-11-01T00:00:00.000Z",
  whenText: "Daily 7:00am", nextRun: null, lastRun: null, runs: [], redStreak: 1, owned: false,
});
const jobs = (name: string, state: Job["state"] = "active"): JobsResponse => ({ at: "2026-11-26T00:00:00.000Z", jobs: [job(name, state)], limits: { active: state === "active" ? 1 : 0, maxActive: 10, tasksToday: 0, maxTasksToday: 6 } });
const cleanup: (() => void)[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 404, headers: { "content-type": "application/json" } }))));
  document.body.replaceChildren();
});
afterEach(() => {
  cleanup.splice(0).reverse().forEach((stop) => stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function jobsHarness() {
  const view = await import("../web/src/views/scheduled.js");
  const sheet = await import("../web/src/views/sheet.js");
  cleanup.push(sheet.closeSheet);
  const reads: ReturnType<typeof deferred<JobsResponse>>[] = [];
  vi.spyOn(view.jobsApi, "get").mockImplementation(() => {
    const read = deferred<JobsResponse>();
    reads.push(read);
    return read.promise;
  });
  return { view, reads };
}

describe("job read ordering", () => {
  it.each(["success", "failure"])("ignores an older %s after a newer load", async (outcome) => {
    const { view, reads } = await jobsHarness();
    const first = view.loadJobs();
    const second = view.loadJobs();
    reads[1]!.resolve(jobs("New reading"));
    await second;
    if (outcome === "success") reads[0]!.resolve(jobs("Old reading"));
    else reads[0]!.reject(new Error("old read failed"));
    await first;
    expect(view.redJobsEl().textContent).toContain("New reading");
    expect(view.redJobsEl().textContent).not.toContain("Couldn't read the jobs again.");
  });

  it("invalidates polls started before a pause completes", async () => {
    const { view, reads } = await jobsHarness();
    const cmd = await import("../web/src/command-api.js");
    let complete!: (entry: AuditEntry) => void;
    vi.spyOn(cmd, "followAction").mockImplementation((_id, next) => { complete = next; return () => {}; });
    const entry: AuditEntry = { id: "action-pause", clientId: "pause-test", kind: "job", at: "2026-11-26T00:00:00.000Z", updatedAt: "2026-11-26T00:00:00.000Z", status: "queued" };
    vi.spyOn(view.jobsApi, "change").mockResolvedValue(entry);
    view.openRedJobs();
    reads[0]!.resolve(jobs("Check app"));
    await flush();
    document.querySelector<HTMLButtonElement>('[data-use="scheduled.pause"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-use="scheduled.confirm"]')!.click();
    await flush();
    // Reopening the sheet and acknowledging the command both read before completion.
    expect(reads).toHaveLength(3);
    complete({ ...entry, status: "succeeded" });
    expect(reads).toHaveLength(4);
    reads[3]!.resolve(jobs("Check app", "paused"));
    await flush();
    reads[1]!.resolve(jobs("Check app"));
    reads[2]!.reject(new Error("old poll failed"));
    await flush();
    expect(view.jobsView()!.jobs[0]!.state).toBe("paused");
    expect(document.body.textContent).toContain("No job is red now.");
    expect(document.body.textContent).not.toContain("Couldn't read the jobs again.");
  });
});
