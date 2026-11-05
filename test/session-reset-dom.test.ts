// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Worker } from "../src/shared/workers.js";
import { call } from "../web/src/api.js";
import { sendWorkerMessage } from "../web/src/command-api.js";
import { loadPushHealth, pushHealth } from "../web/src/push-health.js";
import { StaleSession } from "../web/src/session.js";
import { app, refresh, resetSession, signedOut, whenSignedOut } from "../web/src/state.js";
import { closeSheet } from "../web/src/views/sheet.js";

// A request still out when its session ends answers nothing into the next one, and never signs it out.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = () => json({ error: "Sign in" }, 401);
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Every request waits until the test answers it, by path. */
let waiting: { path: string; body?: string; answer(response: Response): void }[] = [];
const answer = (path: (url: string) => boolean, response: () => Response) => {
  for (const request of waiting.filter((one) => path(one.path))) request.answer(response());
  waiting = waiting.filter((one) => !path(one.path));
};

let signOuts: string[] = [];
let root: HTMLElement;

beforeEach(() => {
  waiting = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => waiting.push({ path: String(input), body: init?.body as string | undefined, answer: resolve }))),
  );
  signOuts = [];
  whenSignedOut((message) => signOuts.push(message));
  root = document.createElement("main");
  document.body.replaceChildren(root);
  resetSession();
});

afterEach(() => {
  closeSheet();
  whenSignedOut(() => {});
  vi.unstubAllGlobals();
});

describe("a request still out when its session ends", () => {
  it("answers StaleSession, for a success and for a 401 alike", async () => {
    const ok = call("GET", "/api/audit?limit=20");
    const no = call("GET", "/api/actions/policy");
    resetSession();
    answer((path) => path.startsWith("/api/audit"), () => json({ entries: [] }));
    answer((path) => path === "/api/actions/policy", refused);
    await expect(ok).rejects.toBeInstanceOf(StaleSession);
    await expect(no).rejects.toBeInstanceOf(StaleSession);
    expect(signOuts).toEqual([]);
  });

  it("a late 401 after signing out does not show the sign-in again, and a late board stays out", async () => {
    const read = refresh();
    signedOut("Signed out.");
    expect(signOuts).toEqual(["Signed out."]);
    answer((path) => path === "/api/board", refused);
    answer(() => true, () => json({}));
    expect(await read).toBe(false);
    expect(signOuts).toEqual(["Signed out."]);
    expect(app.board).toBeNull();
  });

  it("the push health read in the last session never replaces this one's", async () => {
    const health = (subscriptions: number) => ({ configured: true, publicKey: "k", subscriptions, lastRemoval: null });
    const old = loadPushHealth();
    resetSession();
    expect(pushHealth()).toBeNull();
    const now = loadPushHealth();
    const [first, second] = waiting.splice(0, 2);
    second!.answer(json(health(0)));
    await now;
    first!.answer(json(health(1)));
    await old;
    expect(pushHealth()?.subscriptions).toBe(0);
  });

  it("the same message to the same worker in the next session makes its own request and lands", async () => {
    const worker = { repo: "example-org/example-repo", chat: "dragon", name: "Sam", state: "working" } as unknown as Worker;
    const sends = () => waiting.filter((one) => one.path === "/api/chat");
    const old = sendWorkerMessage(worker, "Go", "Go");
    signedOut("Signed out.");
    resetSession();
    const now = sendWorkerMessage(worker, "Go", "Go");
    expect(sends()).toHaveLength(2);
    sends()[1]!.answer(json({ id: "act-b", status: "queued" }));
    await expect(now).resolves.toMatchObject({ id: "act-b" });
    sends()[0]!.answer(json({ id: "act-a", status: "queued" }));
    await expect(old).rejects.toBeInstanceOf(StaleSession);
  });
});
