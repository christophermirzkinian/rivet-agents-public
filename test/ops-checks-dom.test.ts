// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpsResponse, PullRequest } from "../src/shared/ops.js";
import { opsData } from "../web/src/ops-data.js";
import { app } from "../web/src/state.js";
import * as ops from "../web/src/views/ops.js";

const NOW = "2026-10-04T04:00:00.000Z";

function pr(number: number, passed: number, failed: number, pending: number): PullRequest {
  const state = failed ? "fail" : pending ? "pending" : passed ? "pass" : "none";
  return {
    repo: "example-org/example-repo", number, title: `PR ${number}`, url: `https://github.com/x/pull/${number}`, draft: false, author: "dev", labels: [],
    headAt: NOW, updatedAt: NOW, checks: { state, passed, failed, pending, failing: failed ? ["lint"] : [] },
  };
}

let root: HTMLElement;
const show = (prs: PullRequest[]) => {
  opsData.ops = {
    now: NOW, bridge: { connected: true }, mac: null, claude: null, flyAt: null, flyStale: false, flySource: null, healthStaleSince: null, apps: [],
    github: { at: NOW, prs, runs: [], runners: null, queue: null, merged: null, sources: null, stale: false },
    summary: { needs: 0, redCi: 0, failingSchedules: 0, appsDown: 0, disk: { freePct: 41, tone: "ok" } },
  } as unknown as OpsResponse;
  ops.unmount();
  ops.mount(root);
};
const row = (number: number) => [...root.querySelectorAll<HTMLElement>('[data-section="prs"] .ops-row')].find((el) => el.querySelector(".ops-num")?.textContent === `#${number}`)!;
const widths = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".ops-checks-bar > span")].map((seg) => [seg.className, seg.style.width]);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ entries: [] }), { headers: { "content-type": "application/json" } }))));
  root = document.createElement("div");
  document.body.replaceChildren(root);
  opsData.at = Date.now();
  opsData.opsAt = { mono: performance.now(), wall: Date.now() };
  app.tab = "progress";
  app.opsPage = "code";
});

afterEach(() => {
  ops.unmount();
  opsData.ops = null;
  opsData.at = 0;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PR checks bar", () => {
  it("sizes passed and failed by count, leaves running as the track, and labels passed out of all", () => {
    show([pr(1, 6, 0, 4), pr(2, 22, 0, 0), pr(3, 7, 1, 2), pr(4, 0, 0, 0)]);

    const running = row(1);
    expect(widths(running)).toEqual([["ops-checks-passed", "60%"], ["ops-checks-failed", "0%"]]);
    expect(running.querySelector(".ops-checks-label")!.textContent).toBe("6/10 · 4 running");
    expect(running.querySelector(".ops-checks-bar")!.getAttribute("aria-label")).toBe("Checks: 4 running · 6 passed");
    expect(running.querySelector(".ops-checks")!.classList.contains("t-bad")).toBe(false);

    const green = row(2);
    expect(widths(green)).toEqual([["ops-checks-passed", "100%"], ["ops-checks-failed", "0%"]]);
    expect(green.querySelector(".ops-checks-label")!.textContent).toBe("22/22");

    const red = row(3);
    expect(widths(red)).toEqual([["ops-checks-passed", "70%"], ["ops-checks-failed", "10%"]]);
    expect(red.querySelector(".ops-checks-label")!.textContent).toBe("7/10 · 1 failed");
    expect(red.querySelector(".ops-checks")!.classList.contains("t-bad")).toBe(true);
    expect(red.querySelector(".ops-row-fail")!.textContent).toBe("lint");

    const none = row(4);
    expect(none.querySelector(".ops-checks-bar")).toBeNull();
    expect(none.textContent).toContain("No checks");
  });
});
