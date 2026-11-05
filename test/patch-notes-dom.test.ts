// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TimelineEvent, TimelineResponse } from "../src/shared/ops.js";
import { opsData } from "../web/src/ops-data.js";
import { mount, noteText, patchNotes, patchNotesBody, unmount } from "../web/src/views/patch-notes.js";

const sha = (number: number) => number.toString(16).padStart(40, "0");
const merged = (at: string, number: number, title: string, repo = "example-repo"): TimelineEvent => ({
  kind: "merged",
  at,
  repo,
  title,
  number,
  mergeSha: sha(number),
  url: `https://github.com/example-org/${repo}/pull/${number}`,
});
const deploy = (at: string, version: number, app = "rivet-agents", kind: TimelineEvent["kind"] = "deploy"): TimelineEvent => ({
  kind,
  at,
  repo: "example-repo",
  title: `Rivet Agents v${version}`,
  app,
  patchMerges: ({ 40: [330], 41: [333], 43: [326, 327] } as Record<number, number[]>)[version]?.map(sha),
});
const timeline = (events: TimelineEvent[]): TimelineResponse => ({ days: [{ day: "2026-10-02", events }], repos: ["example-repo"] });
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  opsData.timeline = null;
});

describe("Patch notes", () => {
  it("drops a title's PR numbers and starts it with a capital", () => {
    expect(noteText("chat threads, open inbox and thread timeline (#330)")).toBe("Chat threads, open inbox and thread timeline");
    expect(noteText("The menu glows while it loads (#326) (#330)")).toBe("The menu glows while it loads");
    expect(noteText("Viewer polish and clocks (#290, #291) (#293)")).toBe("Viewer polish and clocks");
    expect(noteText("(#12)")).toBe("");
  });

  it("puts each PR under its proven release, newest deploy first", () => {
    const deploys = patchNotes(
      timeline([
        merged("2026-09-30T23:00:00Z", 329, "Shipped by a deploy that aged out (#329)"),
        deploy("2026-10-01T00:00:00Z", 39),
        merged("2026-10-01T01:00:00Z", 330, "chat threads (#330)"),
        deploy("2026-10-01T02:00:00Z", 40),
        merged("2026-10-01T03:00:00Z", 326, "the menu glows (#326)"),
        merged("2026-10-01T03:30:00Z", 327, "faster Ops (#327)"),
        deploy("2026-10-01T04:00:00Z", 41),
        deploy("2026-10-01T04:30:00Z", 42, "rivet-agents", "deploy-failed"),
        deploy("2026-10-01T05:00:00Z", 43),
        deploy("2026-10-01T06:00:00Z", 44),
        merged("2026-10-01T07:00:00Z", 340, "Not out yet (#340)"),
      ]),
    );
    expect(deploys.map((d) => [d.title, d.notes.map((n) => n.text)])).toEqual([
      ["Rivet Agents v43", ["The menu glows", "Faster Ops"]],
      ["Rivet Agents v40", ["Chat threads"]],
    ]);
    expect(deploys[0]?.notes[0]).toMatchObject({ number: 326, url: expect.stringContaining("/pull/326") });
  });

  it("uses build ancestry instead of a merge-to-release timestamp window", () => {
    const a = { ...deploy("2026-10-01T03:00:00Z", 50), patchMerges: [sha(1)] };
    const b = { ...deploy("2026-10-01T04:00:00Z", 51), patchMerges: [sha(2)] };
    const events = [merged("2026-10-01T01:00:00Z", 1, "A"), merged("2026-10-01T02:00:00Z", 2, "B"), a, b];
    expect(patchNotes(timeline(events)).map((d) => [d.title, d.notes.map((n) => n.text)])).toEqual([["Rivet Agents v51", ["B"]], ["Rivet Agents v50", ["A"]]]);
    expect(patchNotes(timeline(events.map((e) => ({ ...e, patchMerges: undefined }))))).toEqual([]);
  });

  it("skips malformed events instead of breaking", () => {
    const bad = {
      days: [
        { day: "2026-10-01", events: [deploy("2026-10-01T00:00:00Z", 1), { kind: "merged", at: "2026-10-01T01:00:00Z", repo: "example-repo", title: ["x"] }, deploy("2026-10-01T02:00:00Z", 2)] },
        { day: "2026-10-02", events: null },
      ],
    } as unknown as TimelineResponse;
    expect(patchNotes(bad)).toEqual([]);
    expect(patchNotes({ days: null } as unknown as TimelineResponse)).toEqual([]);
  });

  it("renders dated deploys with linked notes, and says so when nothing was deployed", () => {
    const deploys = patchNotes(
      timeline([deploy("2026-10-01T00:00:00Z", 39), merged("2026-10-01T01:00:00Z", 330, "chat threads (#330)"), deploy("2026-10-01T02:00:00Z", 40)]),
    );
    const body = patchNotesBody(deploys, true);
    expect(body.querySelector("h3")?.textContent).toMatch(/^Thu 1 Oct 1:00pm · Rivet Agents v40$/);
    const link = body.querySelector("li a");
    expect(link?.getAttribute("href")).toContain("/pull/330");
    expect(link?.textContent).toBe("#330Chat threads");
    expect(patchNotesBody([], true).textContent).toBe("Nothing was deployed in the last 14 days.");
    expect(patchNotesBody([], false).textContent).toBe("Loading the patch notes…");
  });

  it("the Settings sheet shows the timeline Ops holds, then a fresh read of it", async () => {
    opsData.timeline = timeline([deploy("2026-10-01T00:00:00Z", 39), merged("2026-10-01T01:00:00Z", 330, "chat threads (#330)"), deploy("2026-10-01T02:00:00Z", 40)]);
    const fresh = timeline([deploy("2026-10-01T00:00:00Z", 39), merged("2026-10-01T03:00:00Z", 333, "lock-screen replies (#333)"), deploy("2026-10-01T04:00:00Z", 41)]);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(fresh), { status: 200, headers: { "content-type": "application/json" } }))));
    const el = document.createElement("div");
    mount(el);
    expect(el.textContent).toContain("Chat threads");
    await wait();
    await wait();
    expect(el.textContent).toContain("Lock-screen replies");
    expect(el.textContent).not.toContain("Chat threads");
  });

  it("a failed read shows what Ops loaded meanwhile, or says it failed", async () => {
    let fail!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_, reject) => (fail = () => reject(new TypeError("offline"))))));
    const el = document.createElement("div");
    mount(el);
    expect(el.textContent).toContain("Loading the patch notes…");
    opsData.timeline = timeline([deploy("2026-10-01T00:00:00Z", 39), merged("2026-10-01T01:00:00Z", 330, "chat threads (#330)"), deploy("2026-10-01T02:00:00Z", 40)]);
    fail();
    await wait();
    await wait();
    expect(el.textContent).toContain("Chat threads");

    opsData.timeline = null;
    const other = document.createElement("div");
    mount(other);
    fail();
    await wait();
    await wait();
    expect(other.textContent).toContain("Patch notes did not load");
  });
});
