// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditEntry } from "../src/shared/command.js";
import { defaultPicks, MODEL_JOBS, picksFromFile, type ModelPicks, type ModelSettingsResponse } from "../src/shared/models.js";
import { ApiError } from "../web/src/api.js";
import { resetSession } from "../web/src/state.js";
import { closeModels, CONFIRM_MS, ELSEWHERE, loadModels, modelSettings, readLands, refused, SAVED, UNCONFIRMED, UNREAD_EVERY_MS } from "../web/src/views/model-settings.js";
import { flash } from "../web/src/views/toast.js";

// No generic on actual(): the code scanner cannot parse its closing `>()` and would leave this file unscanned.
vi.mock("../web/src/views/toast.js", async (actual) => ({ ...((await actual()) as Record<string, unknown>), flash: vi.fn() }));

// Settings › Who does what against a fake server: the rows stay shut until the Mac has reported, Saved waits for the
// report that carries the save, and a save whose answer was lost goes back to the server's view.

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 11, 8, minutes)).toISOString();
const fable = { ...defaultPicks(), monitor: { model: "claude-fable-5-2", effort: "high" as const } };

let served: ModelSettingsResponse;
/** How POST /api/actions/models answers; by default the Mac writes the picks and reports them. */
let onPost: (jobs: ModelPicks, clientId: string) => Response;
let posts: { jobs: ModelPicks; clientId: string; base: string | null }[] = [];
/** What GET /api/actions/status answers for each action the server has handed out. */
let actions: Map<string, AuditEntry>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function reported(jobs: ModelPicks | null, action?: string, minutes = 10): ModelSettingsResponse {
  return {
    jobs: MODEL_JOBS,
    current: jobs ? picksFromFile(jobs) : null,
    updated: jobs ? { at: at(minutes), by: "The owner (Rivet)", ...(action ? { action } : {}) } : null,
    fileError: null,
    status: {},
    reportedAt: at(minutes),
  };
}

/** The server hands out (or, under a clientId it has seen, hands back) an action in `status`. */
function action(clientId: string, status: AuditEntry["status"], reason?: string): AuditEntry {
  const entry = { id: `act-${clientId}`, clientId, kind: "models", at: at(20), updatedAt: at(20), status, ...(reason ? { detail: { reason } } : {}) } as AuditEntry;
  actions.set(entry.id, entry);
  return entry;
}

const writes = (jobs: ModelPicks, clientId: string) => {
  const entry = action(clientId, "succeeded");
  served = reported(jobs, entry.id, 20);
  return json(entry, 202);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date(at(30)));
  resetSession();
  vi.mocked(flash).mockClear();
  posts = [];
  actions = new Map();
  served = { ...reported(null), reportedAt: null };
  onPost = writes;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "/api/settings/models") return json(served);
    if (url === "/api/actions/models" && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { clientId: string; jobs: ModelPicks; base: string | null };
      posts.push(body);
      return onPost(body.jobs, body.clientId);
    }
    if (url.startsWith("/api/actions/status?id=")) {
      const found = actions.get(decodeURIComponent(url.slice("/api/actions/status?id=".length)));
      return found ? json(found) : json({ error: "no such action" }, 404);
    }
    throw new Error(`unexpected ${url}`);
  });
});

afterEach(() => {
  closeModels();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const selects = () => [...modelSettings().querySelectorAll("select")];
const footer = () => modelSettings().querySelector(".mdl-foot")?.textContent;
const monitorSelect = () => selects().find((select) => select.getAttribute("data-use") === "settings.models.monitor.model")!;
const editable = () => selects().filter((select) => !select.disabled).length > 0;

function pickMonitor(model: string): void {
  const select = monitorSelect();
  select.value = model;
  select.dispatchEvent(new Event("change"));
}

describe("the guards", () => {
  it("a read begun before the latest save never lands", () => {
    expect(readLands(4, 5, 0)).toBe(false);
    expect(readLands(6, 5, 0)).toBe(true);
  });
  it("a read begun before one that has landed never lands", () => {
    expect(readLands(6, 5, 7)).toBe(false);
    expect(readLands(8, 5, 7)).toBe(true);
  });
  it("only an undelivered action or a clear refusal is sure to have left the file alone", () => {
    expect(refused(new ApiError(503, "the Mac is offline", true))).toBe(true);
    expect(refused(new ApiError(400, "bad picks"))).toBe(true);
    for (const status of [0, 408, 429, 500, 502, 503]) expect(refused(new ApiError(status, "lost")), String(status)).toBe(false);
    expect(refused(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("Who does what", () => {
  it("keeps the rows shut until the Mac has reported, reading again until it does", async () => {
    await loadModels();
    expect(selects()).toHaveLength(MODEL_JOBS.length * 2);
    expect(editable()).toBe(false);
    expect(footer()).toBe("Not read from the Mac yet.");
    served = reported(fable, "a1");
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS);
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-fable-5-2");
  });

  it("PR reviews on Opus offer High to Max, never Low or Medium", async () => {
    served = reported(null);
    await loadModels();
    const effort = selects().find((select) => select.getAttribute("data-use") === "settings.models.review-lens.effort")!;
    expect([...effort.options].map((option) => option.value)).toEqual(["high", "xhigh", "max"]);
  });

  it("takes the defaults as true once the Mac reports it has no file", async () => {
    served = reported(null);
    await loadModels();
    expect(editable()).toBe(true);
    expect(footer()).toBe("On the defaults; nothing changed yet.");
  });

  it("says Saved only once the server's report carries the save", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    pickMonitor("claude-fable-5-2");
    expect(editable()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(1);
    expect(flash).toHaveBeenCalledWith(SAVED);
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-fable-5-2");
  });

  it("an ack with no report of it is not Saved; a report of another save from before the ack keeps the rows shut, the one carrying it opens them", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    let id = "";
    onPost = (_jobs, clientId) => {
      const entry = action(clientId, "succeeded");
      id = entry.id;
      return json(entry, 202);
    };
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(CONFIRM_MS + 2000);
    expect(flash).toHaveBeenCalledWith(UNCONFIRMED, "warn");
    expect(flash).not.toHaveBeenCalledWith(SAVED);
    expect(monitorSelect().value).toBe("claude-opus-5-5");
    expect(editable()).toBe(false);
    expect(footer()).toBe("Checking what the Mac holds.");
    served = reported(fable, "late", 20);
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS * 2);
    expect(editable()).toBe(false);
    served = reported(fable, id, 22);
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS);
    expect(flash).toHaveBeenCalledWith(SAVED);
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-fable-5-2");
  });

  it("a save that times out stays shut through a periodic report without it, and opens Saved on the report carrying it", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    let id = "";
    onPost = (_jobs, clientId) => {
      const entry = action(clientId, "queued");
      id = entry.id;
      return json(entry, 202);
    };
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(CONFIRM_MS + 2000);
    expect(flash).toHaveBeenCalledWith(UNCONFIRMED, "warn");
    expect(editable()).toBe(false);
    served = reported(defaultPicks(), "a0", 21);
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS * 3);
    expect(editable()).toBe(false);
    expect(footer()).toBe("Checking what the Mac holds.");
    expect(monitorSelect().value).toBe("claude-opus-5-5");
    expect(posts).toHaveLength(1);
    served = reported(fable, id, 22);
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS);
    expect(flash).toHaveBeenCalledWith(SAVED);
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-fable-5-2");
  });

  it("a lost answer is sent again under the same clientId, and the save it finds opens Saved on its report", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    onPost = (jobs, clientId) => {
      writes(jobs, clientId);
      onPost = (_jobs, again) => json(actions.get(`act-${again}`), 200);
      return json({ error: "bad gateway" }, 502);
    };
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(flash).toHaveBeenCalledWith(expect.stringMatching(/^Not confirmed: /), "warn");
    expect(editable()).toBe(false);
    expect(flash).not.toHaveBeenCalledWith(SAVED);
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS * 2);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(flash).toHaveBeenCalledWith(SAVED);
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-fable-5-2");
  });

  it("a lost answer sent again and followed to refused goes back to the server's view, open on a report after the ack", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    onPost = () => {
      onPost = (_jobs, clientId) => json(action(clientId, "queued"), 202);
      return json({ error: "bad gateway" }, 502);
    };
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(editable()).toBe(false);
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(editable()).toBe(false);
    const id = `act-${posts[1]!.clientId}`;
    actions.set(id, { ...actions.get(id)!, status: "refused", updatedAt: at(21), detail: { reason: "Not on the allowed list." } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(flash).toHaveBeenCalledWith("Not saved: Not on the allowed list.", "error");
    expect(editable()).toBe(false);
    expect(monitorSelect().value).toBe("claude-opus-5-5");
    served = reported(defaultPicks(), "a0", 22);
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS);
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-opus-5-5");
    expect(footer()).toMatch(/^Changed /);
  });

  it("a failed ack stays shut through a read of the report from before it, and opens on one the server took after it", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    onPost = (_jobs, clientId) => json(action(clientId, "failed", "the Mac restarted while saving these picks"), 202);
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(flash).toHaveBeenCalledWith("Not saved: the Mac restarted while saving these picks", "error");
    expect(editable()).toBe(false);
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS * 2);
    expect(editable()).toBe(false);
    expect(footer()).toBe("Checking what the Mac holds.");
    served = reported(fable, "a0", 21);
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS);
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-fable-5-2");
    expect(flash).not.toHaveBeenCalledWith(SAVED);
  });

  it("a succeeded save another screen's saved over opens on the later report, with no Saved", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    const other = { ...defaultPicks(), "work-chats": { model: "claude-fable-5-2", effort: "high" as const } };
    onPost = (_jobs, clientId) => {
      served = reported(other, "other", 21);
      return json(action(clientId, "succeeded"), 202);
    };
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(CONFIRM_MS + 2000);
    expect(flash).not.toHaveBeenCalledWith(SAVED);
    expect(flash).toHaveBeenCalledWith(ELSEWHERE, "warn");
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-opus-5-5");
    expect(selects().find((select) => select.getAttribute("data-use") === "settings.models.work-chats.model")!.value).toBe("claude-fable-5-2");
  });

  it("shuts the rows on a file the Mac can't read after a confirmed save", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(flash).toHaveBeenCalledWith(SAVED);
    expect(editable()).toBe(true);
    served = { ...reported(null), fileError: "model-routing.json unreadable: EIO" };
    await loadModels();
    expect(editable()).toBe(false);
    expect(footer()).toBe("Can't read the Mac's picks file, so changes wait until it can.");
  });

  it("takes a report of no file after a confirmed save: the defaults, open, and the next save names no base", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(flash).toHaveBeenCalledWith(SAVED);
    served = reported(null);
    await loadModels();
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-opus-5-5");
    expect(footer()).toBe("On the defaults; nothing changed yet.");
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.base).toBeNull();
  });

  it("each save names the save its view showed, or null when the view showed none", async () => {
    served = reported(null);
    await loadModels();
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(posts[0]!.base).toBeNull();
    expect(posts[0]!.jobs.monitor.model).toBe("claude-fable-5-2");
    const id = `act-${posts[0]!.clientId}`;
    pickMonitor("claude-opus-5-5");
    await vi.advanceTimersByTimeAsync(0);
    expect(posts[1]!.base).toBe(id);
  });

  it("keeps the rows shut while the Mac can't read its picks file, and opens them once it can", async () => {
    served = { ...reported(null), fileError: "model-routing.json unreadable: EACCES" };
    await loadModels();
    expect(editable()).toBe(false);
    expect(footer()).toBe("Can't read the Mac's picks file, so changes wait until it can.");
    pickMonitor("claude-fable-5-2");
    expect(posts).toHaveLength(0);
    served = reported(fable, "a0", 12);
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS);
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-fable-5-2");
  });

  it("an undelivered save goes back to the picks before it", async () => {
    served = reported(fable, "a0");
    await loadModels();
    onPost = () => json({ error: "the Mac is offline", undelivered: true }, 503);
    pickMonitor("claude-opus-5-5");
    await vi.advanceTimersByTimeAsync(0);
    expect(flash).toHaveBeenCalledWith(expect.stringMatching(/^Not saved: /), "error");
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-fable-5-2");
  });

  it("a read begun before a save never lands over it", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    let release: (() => void) | null = null;
    const slow = vi.fn(async () => {
      const old = served;
      await new Promise<void>((resolve) => (release = resolve));
      return json(old);
    });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => (String(input) === "/api/settings/models" && !release ? slow() : real(input, init)));
    const stale = loadModels();
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(flash).toHaveBeenCalledWith(SAVED);
    release!();
    await stale;
    expect(monitorSelect().value).toBe("claude-fable-5-2");
  });

  it("a confirm read that comes back after a newer read has landed keeps the newer view, with no Saved", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    let release: (() => void) | null = null;
    let held = false;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/settings/models" && posts.length === 1 && !held) {
        held = true;
        const carrying = served;
        await new Promise<void>((resolve) => (release = resolve));
        return json(carrying);
      }
      return real(input, init);
    });
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toBe(true);
    // Another screen saves over it, and a read begun after the confirm read lands that newer report first.
    const other = { ...defaultPicks(), monitor: { model: "claude-opus-5-5", effort: "max" as const } };
    served = reported(other, "other", 25);
    await loadModels();
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(flash).not.toHaveBeenCalledWith(SAVED);
    expect(flash).toHaveBeenCalledWith(ELSEWHERE, "warn");
    expect(monitorSelect().value).toBe("claude-opus-5-5");
    expect(editable()).toBe(true);
  });

  it("a confirm read overtaken by a read of a file the Mac can't read keeps reading, and opens once the Mac can", async () => {
    served = reported(defaultPicks(), "a0");
    await loadModels();
    let release: (() => void) | null = null;
    let held = false;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/settings/models" && posts.length === 1 && !held) {
        held = true;
        const carrying = served;
        await new Promise<void>((resolve) => (release = resolve));
        return json(carrying);
      }
      return real(input, init);
    });
    pickMonitor("claude-fable-5-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toBe(true);
    const saved = served;
    served = { ...reported(null, undefined, 25), fileError: "unreadable" };
    await loadModels();
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(editable()).toBe(false);
    // No other screen saved: the Mac just can't read its file, which the footer says.
    expect(flash).not.toHaveBeenCalledWith(ELSEWHERE, "warn");
    served = { ...saved, reportedAt: at(26) };
    await vi.advanceTimersByTimeAsync(UNREAD_EVERY_MS + 100);
    expect(editable()).toBe(true);
    expect(monitorSelect().value).toBe("claude-fable-5-2");
  });
});
