// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_NAME, appName, chatName, RIVET_NAME, rivetWords, STORED_NAME, UNNAMED_AGENT } from "../src/shared/names.js";
import type { Worker } from "../src/shared/workers.js";
import { agentName, agentNoun, CONNECT_PATH, hostedPage, leaveCloud, needsPlan, noPlan, ownMachineAfterEnrol, parseAgent, parsePlans, probeCloud, readCloud, readServedApp, resetCloud, tabTitle } from "../web/src/cloud-agent.js";
import type { Ask } from "../src/shared/asks.js";
import { opsData } from "../web/src/ops-data.js";
import { app, changed } from "../web/src/state.js";
import { mount as mountOps, unmount as unmountOps } from "../web/src/views/ops.js";
import { openStatus as openRunner, runnerItem } from "../web/src/views/ops-status.js";
import { openMore } from "../web/src/views/chat-more.js";
import { activityRows, askedBy, WHO_CHIPS, WHO_EMPTY } from "../web/src/views/chat-ticket.js";
import { answerCard, offlineBar } from "../web/src/views/feed.js";
import { menuList } from "../web/src/views/menu.js";
import { mindNameless } from "../web/src/views/mind.js";
import { PAGE_NAMES } from "../web/src/views/more.js";
import { READ_WORDS } from "../web/src/views/progress-mark.js";
import { closeSheet } from "../web/src/views/sheet.js";
import { mountShell } from "../web/src/views/shell.js";
import { closeWorkerSheet, openWorkerSheet } from "../web/src/views/worker-sheet.js";

// A hosted machine's supervisor answers /cloud/agent and /cloud/connect/status on the app's origin; the owner's own
// machine answers neither, and shows what it always did.

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** The owner's own server's answer for a path it doesn't serve (http.ts). */
const ownServer404 = () => new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
const asked: string[] = [];
let answers: Record<string, () => Response> = {};

beforeEach(() => {
  resetCloud();
  asked.length = 0;
  answers = {};
  document.title = "Rivet Agents";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      asked.push(path);
      return (answers[path] ?? ownServer404)();
    }),
  );
});

afterEach(() => {
  resetCloud();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("parseAgent", () => {
  it("takes the supervisor's answer, a blank name as none", () => {
    expect(parseAgent({ name: "Pip", setupDone: true, firstPlan: "chatgpt" })).toEqual({ name: "Pip", setupDone: true, firstPlan: "chatgpt", app: null });
    expect(parseAgent({ name: null, setupDone: false, firstPlan: "claude" })).toEqual({ name: null, setupDone: false, firstPlan: "claude", app: null });
    expect(parseAgent({ name: "  ", setupDone: true })).toEqual({ name: null, setupDone: true, firstPlan: "claude", app: null });
    expect(parseAgent({ name: "Pip", setupDone: true, app: "Acme Agents" })).toEqual({ name: "Pip", setupDone: true, firstPlan: "claude", app: "Acme Agents" });
  });

  it("takes a name and an app by the server's rule, anything else as none, as the server does", () => {
    for (const name of ["Dr. Pip", "Pip_2", "A".repeat(25), "<b>Pip</b>", "Rivet and Bolt", "rivet jr"]) expect(parseAgent({ name, setupDone: true })?.name).toBeNull();
    expect(parseAgent({ name: "Rivetyun", setupDone: true, app: "<i>Acme</i>" })).toMatchObject({ name: "Rivetyun", app: null });
  });

  it("reads a supervisor that can't tell yet as hosted and set up, never as not set up", () => {
    expect(parseAgent({ name: null, setupDone: true, firstPlan: "claude", unknown: true })).toEqual({ name: null, setupDone: true, firstPlan: "claude", app: null });
    expect(parseAgent({ name: null, setupDone: false, unknown: true })?.setupDone).toBe(true);
    expect(parseAgent({ unknown: true })?.setupDone).toBe(true);
  });

  it("reads anything without a boolean setupDone as not hosted", () => {
    expect(parseAgent({ name: "Pip" })).toBeNull();
    expect(parseAgent({ name: "Pip", setupDone: "yes" })).toBeNull();
    expect(parseAgent("<!doctype html>")).toBeNull();
    expect(parseAgent(null)).toBeNull();
  });
});

describe("parsePlans", () => {
  it("reads each plan, and an older supervisor's loggedIn as Claude", () => {
    expect(parsePlans({ claude: false, chatgpt: true, github: false, loggedIn: false })).toEqual({ claude: false, chatgpt: true });
    expect(parsePlans({ loggedIn: true })).toEqual({ claude: true, chatgpt: false });
    expect(parsePlans({ loggedIn: false })).toEqual({ claude: false, chatgpt: false });
  });

  it("reads an answer with no plan in it as unread", () => {
    expect(parsePlans({ github: true })).toBeNull();
    expect(parsePlans([])).toEqual(null);
    expect(parsePlans(null)).toBeNull();
  });
});

describe("the probe", () => {
  it("is not hosted on the owner's own server's 404, and stops asking", async () => {
    expect(await probeCloud()).toBeNull();
    await readCloud(() => {});
    await readCloud(() => {});
    expect(asked).toEqual(["/cloud/agent"]);
    expect(agentName()).toBe("Rivet");
  });

  it("asks again after a redirect, a sign-in page in place of JSON, a 404 page, a 401 or a network error, never taking it as not hosted", async () => {
    const redirected = () => {
      const response = new Response("Not found", { status: 404 });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    };
    const misses: (() => Response)[] = [
      redirected,
      () => new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response("<!doctype html><title>Not found</title>", { status: 404, headers: { "content-type": "text/html" } }),
      () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } }),
      () => new Response(JSON.stringify(["not", "found"]), { status: 404, headers: { "content-type": "application/json" } }),
      () => new Response(JSON.stringify({ error: "sign in" }), { status: 401, headers: { "content-type": "application/json" } }),
      () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    for (const miss of misses) {
      answers["/cloud/agent"] = miss;
      expect(await probeCloud()).toBeNull();
      await readCloud(() => {});
    }
    expect(asked).toHaveLength(2 * misses.length);
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    await readCloud(() => {});
    expect(agentName()).toBe("Pip");
  });

  it("takes a supervisor that can't tell yet as hosted, naming the agent Agent and sending nobody to setup", async () => {
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    answers["/cloud/agent"] = () => json({ app: "Acme Agents", name: null, setupDone: true, firstPlan: "claude", unknown: true });
    expect(await probeCloud()).toMatchObject({ setupDone: true });
    await readCloud(() => {});
    expect(agentName()).toBe("Agent");
    expect(assign).not.toHaveBeenCalled();
    expect(needsPlan()).toBe(false);
    assign.mockRestore();
  });

  it("names the app as its host does, or by its own name", async () => {
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    await probeCloud();
    expect(appName()).toBe(APP_NAME);
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude", app: "Acme Agents" });
    await probeCloud();
    expect(appName()).toBe("Acme Agents");
    resetCloud();
    expect(appName()).toBe(APP_NAME);
  });

  it("names the app from the page the server served before anyone signs in, and keeps it after a sign-out", async () => {
    const meta = document.createElement("meta");
    meta.name = "application-name";
    meta.content = APP_NAME;
    document.head.append(meta);
    readServedApp();
    expect(appName()).toBe(APP_NAME);
    meta.content = "Acme Agents";
    readServedApp();
    expect(appName()).toBe("Acme Agents");
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    await probeCloud();
    leaveCloud();
    expect(appName()).toBe("Acme Agents");
    meta.remove();
  });

  it("never shows the build's name in a stored line on a hosted page whose app is the build's own: at load, after a sign-out, on a probe miss", async () => {
    const app = Object.assign(document.createElement("meta"), { name: "application-name", content: APP_NAME });
    const mark = Object.assign(document.createElement("meta"), { name: "hosted-agent", content: "1" });
    const shown = () => [RIVET_NAME, agentName(), rivetWords(`${STORED_NAME} is on it`), rivetWords("Rivet is on it")];
    const unnamed = [UNNAMED_AGENT, UNNAMED_AGENT, `${UNNAMED_AGENT} is on it`, `${UNNAMED_AGENT} is on it`];
    document.head.append(app);
    try {
      readServedApp();
      expect(shown()).toEqual(["Rivet", "Rivet", "Rivet is on it", "Rivet is on it"]);
      document.head.append(mark);
      readServedApp();
      expect(asked).toEqual([]);
      expect(shown()).toEqual(unnamed);
      answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
      await probeCloud();
      expect(shown()).toEqual(["Pip", "Pip", "Pip is on it", "Pip is on it"]);
      leaveCloud();
      expect(shown()).toEqual(unnamed);
      const misses: (() => Response)[] = [
        () => new Response("Bad gateway", { status: 502, headers: { "content-type": "text/plain" } }),
        () => {
          throw new TypeError("Failed to fetch");
        },
      ];
      for (const miss of misses) {
        answers["/cloud/agent"] = miss;
        expect(await probeCloud()).toBeNull();
        await readCloud(() => {});
        expect(shown()).toEqual(unnamed);
      }
      expect(appName()).toBe(APP_NAME);
    } finally {
      app.remove();
      mark.remove();
    }
  });

  it("names a hosted agent Agent until it has a name of its own", async () => {
    answers["/cloud/agent"] = () => json({ name: null, setupDone: true, firstPlan: "claude" });
    expect(await probeCloud()).not.toBeNull();
    expect(agentName()).toBe("Agent");
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    await probeCloud();
    expect(agentName()).toBe("Pip");
  });

  it("titles the tab with the agent's name alone", () => {
    expect(tabTitle("Pip")).toBe("Pip");
  });
});

describe("readCloud", () => {
  it("on the owner's own machine changes nothing and asks once", async () => {
    const onChange = vi.fn();
    await readCloud(onChange);
    await readCloud(onChange);
    expect(asked).toEqual(["/cloud/agent"]);
    expect(onChange).not.toHaveBeenCalled();
    expect(document.title).toBe("Rivet Agents");
    expect(needsPlan()).toBe(false);
    expect(PAGE_NAMES.mind).toBe("Rivet's mind");
    expect(menuList().querySelector('[data-key="connect"]')).toBeNull();
  });

  it("with no plan connected needs one and shows the menu row to the connect page, then neither once one is", async () => {
    const onChange = vi.fn();
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    answers["/cloud/connect/status"] = () => json({ claude: false, chatgpt: false, github: false, loggedIn: false });
    await readCloud(onChange);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.title).toBe("Pip");
    expect(PAGE_NAMES.mind).toBe("Pip's mind");
    expect(needsPlan()).toBe(true);
    const row = menuList().querySelector<HTMLElement>('[data-key="connect"]')!;
    expect(row.textContent).toBe("Connect a plan");
    expect(row.dataset.use).toBe("menu.row.connect");

    answers["/cloud/connect/status"] = () => json({ claude: false, chatgpt: true, github: false, loggedIn: false });
    await readCloud(onChange);
    expect(needsPlan()).toBe(false);
    expect(menuList().querySelector('[data-key="connect"]')).toBeNull();
  });

  it("needs no plan while the status cannot be read", async () => {
    answers["/cloud/agent"] = () => json({ name: null, setupDone: true, firstPlan: "claude" });
    await readCloud(() => {});
    expect(document.title).toBe("Agent");
    expect(needsPlan()).toBe(false);
  });
});

describe("a write refused for want of a plan", () => {
  it("is none connected from then on, redrawn as a read would, until a read finds one", async () => {
    const onChange = vi.fn();
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    answers["/cloud/connect/status"] = () => json({ claude: true, chatgpt: false });
    await readCloud(onChange);
    expect(needsPlan()).toBe(false);
    expect(noPlan()).toBe(true);
    expect(needsPlan()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(2);
    await readCloud(onChange);
    expect(needsPlan()).toBe(false);
  });

  it("is read again every 15 seconds and at the window's focus while none is connected, and lifts by itself", async () => {
    vi.useFakeTimers();
    const reads = () => asked.filter((path) => path === "/cloud/connect/status").length;
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    answers["/cloud/connect/status"] = () => json({ claude: false, chatgpt: false });
    const onChange = vi.fn();
    await readCloud(onChange);
    expect(needsPlan()).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reads()).toBe(2);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(3);
    expect(onChange).toHaveBeenCalledTimes(1);
    answers["/cloud/connect/status"] = () => json({ claude: false, chatgpt: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(needsPlan()).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(4);
  });

  it("starts no second read while one is still out", async () => {
    vi.useFakeTimers();
    const reads = () => asked.filter((path) => path === "/cloud/connect/status").length;
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    answers["/cloud/connect/status"] = () => json({ claude: false, chatgpt: false });
    await readCloud(() => {});
    let answer: (response: Response) => void = () => {};
    answers["/cloud/connect/status"] = () => new Promise<Response>((done) => (answer = done)) as unknown as Response;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(5_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(2);
    answer(json({ claude: true, chatgpt: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(needsPlan()).toBe(false);
  });

  it("gives up a read that never answers, so a later read still lifts the lock", async () => {
    vi.useFakeTimers();
    const reads = () => asked.filter((path) => path === "/cloud/connect/status").length;
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    answers["/cloud/connect/status"] = () => json({ claude: false, chatgpt: false });
    await readCloud(() => {});
    answers["/cloud/connect/status"] = () => new Promise<Response>(() => {}) as unknown as Response;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads()).toBe(2);
    answers["/cloud/connect/status"] = () => json({ claude: true, chatgpt: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads()).toBe(3);
    expect(needsPlan()).toBe(false);
  });

  it("drops an answer older than one already applied", async () => {
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    let answer: (response: Response) => void = () => {};
    answers["/cloud/connect/status"] = () => new Promise<Response>((done) => (answer = done)) as unknown as Response;
    const older = readCloud(() => {});
    await vi.waitFor(() => expect(asked).toContain("/cloud/connect/status"));
    const late = answer;
    answers["/cloud/connect/status"] = () => json({ claude: true, chatgpt: false });
    await readCloud(() => {});
    expect(needsPlan()).toBe(false);
    late(json({ claude: false, chatgpt: false }));
    await older;
    expect(needsPlan()).toBe(false);
  });

  it("stops reading while the tab is hidden", async () => {
    vi.useFakeTimers();
    const reads = () => asked.filter((path) => path === "/cloud/connect/status").length;
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    answers["/cloud/connect/status"] = () => json({ claude: false, chatgpt: false });
    await readCloud(() => {});
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toBe(1);
    hidden.mockRestore();
  });

  it("keeps the lock against a read sent before the refusal, and a newer read lifts it", async () => {
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    let answer: (response: Response) => void = () => {};
    answers["/cloud/connect/status"] = () => new Promise<Response>((done) => (answer = done)) as unknown as Response;
    const read = readCloud(() => {});
    await vi.waitFor(() => expect(asked).toContain("/cloud/connect/status"));
    expect(noPlan()).toBe(true);
    answer(json({ claude: true, chatgpt: false }));
    await read;
    expect(needsPlan()).toBe(true);
    answers["/cloud/connect/status"] = () => json({ claude: true, chatgpt: false });
    await readCloud(() => {});
    expect(needsPlan()).toBe(false);
  });

  it("locks on a hosted page whose probe has not answered yet", () => {
    document.head.innerHTML = `<meta name="hosted-agent" content="1" />`;
    readServedApp();
    expect(noPlan()).toBe(true);
    expect(needsPlan()).toBe(true);
    document.head.replaceChildren();
  });

  it("changes nothing on the owner's own machine", async () => {
    const onChange = vi.fn();
    await readCloud(onChange);
    expect(noPlan()).toBe(false);
    expect(needsPlan()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(asked).toEqual(["/cloud/agent"]);
  });
});

describe("a sign-out", () => {
  beforeEach(() => {
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    answers["/cloud/connect/status"] = () => json({ claude: false, chatgpt: false });
  });

  it("takes the plans read and the Connect a plan menu row away, and the next sign-in reads them again", async () => {
    await readCloud(() => {});
    expect(needsPlan()).toBe(true);
    leaveCloud();
    expect(needsPlan()).toBe(false);
    expect(menuList().querySelector('[data-key="connect"]')).toBeNull();
    await readCloud(() => {});
    expect(needsPlan()).toBe(true);
  });

  it("puts the tab and the name back to the served app's, with the unnamed agent and never the build's own name", async () => {
    document.head.innerHTML = `<meta name="application-name" content="Acme Cloud" /><meta name="hosted-agent" content="1" />`;
    readServedApp();
    expect(RIVET_NAME).toBe(UNNAMED_AGENT);
    await readCloud(() => {});
    expect(document.title).toBe("Pip");
    expect(RIVET_NAME).toBe("Pip");
    leaveCloud();
    expect(document.title).toBe("Acme Cloud");
    expect(appName()).toBe("Acme Cloud");
    expect(RIVET_NAME).toBe(UNNAMED_AGENT);
    expect(agentName()).toBe(UNNAMED_AGENT);
    expect(document.title + RIVET_NAME).not.toMatch(/Pip/);
    answers["/cloud/agent"] = () => new Response("Bad gateway", { status: 502 });
    await readCloud(() => {});
    expect(RIVET_NAME).toBe(UNNAMED_AGENT);
    document.head.replaceChildren();
  });

  it("leaves the owner's own tab as it was", async () => {
    answers = {};
    await readCloud(() => {});
    leaveCloud();
    expect(document.title).toBe(APP_NAME);
    expect(RIVET_NAME).toBe(STORED_NAME);
  });

  it("drops a read still on its way", async () => {
    const onChange = vi.fn();
    const reading = readCloud(onChange);
    leaveCloud();
    await reading;
    expect(needsPlan()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(RIVET_NAME).toBe(STORED_NAME);
    expect(hostedPage()).toBe(false);
  });

  it("drops a probe still on its way, on a served app's page and after a passkey is made", async () => {
    document.head.innerHTML = `<meta name="application-name" content="Acme Cloud" /><meta name="hosted-agent" content="1" />`;
    readServedApp();
    const probing = probeCloud();
    leaveCloud();
    expect(await probing).toBeNull();
    expect(RIVET_NAME).toBe(UNNAMED_AGENT);
    expect([hostedPage(), agentName()]).toEqual([true, UNNAMED_AGENT]);
    const enrolling = ownMachineAfterEnrol();
    leaveCloud();
    expect(await enrolling).toBe(false);
    expect(RIVET_NAME).toBe(UNNAMED_AGENT);
    expect([hostedPage(), agentName()]).toEqual([true, UNNAMED_AGENT]);
    document.head.replaceChildren();
  });

  it("stops a missed probe's asking", async () => {
    vi.useFakeTimers();
    answers["/cloud/agent"] = () => new Response("Bad gateway", { status: 502 });
    await readCloud(() => {});
    leaveCloud();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(asked).toEqual(["/cloud/agent"]);
  });
});

describe("a probe that missed", () => {
  const probes = () => asked.filter((path) => path === "/cloud/agent").length;
  const pip = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });

  it("is asked again after 5, 15 and 60 seconds, then on the window's focus, until it answers", async () => {
    vi.useFakeTimers();
    answers["/cloud/agent"] = () => {
      throw new TypeError("Failed to fetch");
    };
    const onChange = vi.fn();
    await readCloud(onChange);
    expect(probes()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(probes()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes()).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probes()).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probes()).toBe(4);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(probes()).toBe(4);
    expect(agentName()).toBe("Rivet");

    answers["/cloud/agent"] = pip;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(probes()).toBe(5);
    expect(agentName()).toBe("Pip");
    expect(document.title).toBe("Pip");
    expect(onChange).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(probes()).toBe(5);
  });

  it("is asked again on the app's return after a 5xx, and a 404 ends the asking", async () => {
    vi.useFakeTimers();
    answers["/cloud/agent"] = () => new Response("Bad gateway", { status: 502 });
    await readCloud(() => {});
    await readCloud(() => {});
    expect(probes()).toBe(2);

    delete answers["/cloud/agent"];
    await readCloud(() => {});
    expect(probes()).toBe(3);
    await readCloud(() => {});
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(probes()).toBe(3);
    expect(agentName()).toBe("Rivet");
  });

  it("finds a hosted agent on the backoff", async () => {
    vi.useFakeTimers();
    answers["/cloud/agent"] = () => new Response("Service unavailable", { status: 503 });
    const onChange = vi.fn();
    await readCloud(onChange);
    answers["/cloud/agent"] = pip;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(agentName()).toBe("Pip");
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(probes()).toBe(2);
  });
});

describe("after an enrol", () => {
  it("starts the app only on the owner's own server's 404", async () => {
    expect(await ownMachineAfterEnrol()).toBe(true);
  });

  it("does not start it on a hosted machine", async () => {
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    expect(await ownMachineAfterEnrol()).toBe(false);
  });

  it("asks again after 1, 2 and 4 seconds while it cannot tell, then does not start it", async () => {
    vi.useFakeTimers();
    answers["/cloud/agent"] = () => new Response("Bad gateway", { status: 502 });
    const own = ownMachineAfterEnrol();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await own).toBe(false);
    expect(asked).toHaveLength(4);
  });

  it("starts it once a retry reaches the owner's own server", async () => {
    vi.useFakeTimers();
    answers["/cloud/agent"] = () => {
      throw new TypeError("Failed to fetch");
    };
    const own = ownMachineAfterEnrol();
    await vi.advanceTimersByTimeAsync(0);
    delete answers["/cloud/agent"];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await own).toBe(true);
    expect(asked).toHaveLength(2);
  });
});

describe("the agent's name in the app's words", () => {
  const ask = { id: "a-1", who: "rivet", createdAt: new Date().toISOString(), timeline: [{ at: new Date().toISOString(), by: "rivet", note: "on it" }], dueHistory: [] } as unknown as Ask;

  afterEach(() => {
    app.notice = null;
    closeSheet();
  });

  function words(): Record<string, unknown> {
    app.notice = "Request failed (500)";
    openMore({ line: "a line", listen: null, copy: null, share: null, card: null, stop: () => {} });
    return {
      desk: READ_WORDS.failed,
      offline: offlineBar()!.querySelector(".feed-offline-t")!.textContent,
      chip: WHO_CHIPS.find((chip) => chip.key === "rivet")!.label,
      empty: WHO_EMPTY.rivet,
      asked: askedBy(ask).split(" · ")[0],
      activity: activityRows(ask, "", [], null)[0]!.name,
      stop: document.querySelector('[data-use="chat.more.stop"]')!.textContent,
    };
  }

  const said = (name: string) => ({
    desk: `Can't reach ${name}.`,
    offline: `Can't reach ${name} · no cards loaded yet`,
    chip: name,
    empty: `Nothing from ${name} on this yet.`,
    asked: name,
    activity: name,
    stop: `Stop itAsks first, then tells ${name} to stop`,
  });

  it("is Rivet on the owner's own machine", async () => {
    await probeCloud();
    expect(words()).toEqual(said("Rivet"));
  });

  it("is a hosted agent's own name", async () => {
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    await probeCloud();
    expect(words()).toEqual(said("Pip"));
  });

  it("is Agent for a hosted agent with no name yet", async () => {
    answers["/cloud/agent"] = () => json({ name: null, setupDone: true, firstPlan: "claude" });
    await probeCloud();
    expect(words()).toEqual(said("Agent"));
  });
});

describe("the agent's name on Ops", () => {
  afterEach(() => {
    closeSheet();
    unmountOps();
    app.notice = null;
    opsData.statuses = null;
  });

  function words(): Record<string, unknown> {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    opsData.statuses = [];
    const fields = () =>
      Object.fromEntries([...document.querySelectorAll(".ops-status-detail h3.ops-status-label")].map((label) => [label.textContent, label.nextElementSibling?.textContent]));
    openRunner(runnerItem("example-mac-6"));
    const runner = fields();
    closeSheet();
    app.notice = "Request failed (500)";
    app.tab = "progress";
    app.opsPage = "plan";
    const root = document.createElement("div");
    document.body.append(root);
    mountOps(root);
    return { who: runner.Who, latest: runner.Latest, plan: root.textContent?.includes(`Can't reach ${agentName()}.`) };
  }

  it("is Rivet on the owner's own machine", async () => {
    await probeCloud();
    expect(words()).toEqual({ who: "Rivet, picking it up", latest: "No update yet: Rivet is picking this up.", plan: true });
  });

  it("is a hosted agent's own name", async () => {
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    await probeCloud();
    expect(words()).toEqual({ who: "Pip, picking it up", latest: "No update yet: Pip is picking this up.", plan: true });
    expect(document.body.textContent).not.toContain("Rivet");
  });
});

describe("the monitor's name everywhere it is read (RIVET_NAME)", () => {
  const worker: Worker = { id: "h", name: "monitor", repo: "example-org/example-repo", chat: "monitor", state: "working", lastOutputAt: null, rivet: true };
  let unmount: (() => void) | null = null;
  /** The side column and each worker sheet as opened. The home screen's own desks are the owner's projects, not in a hosted build. */
  let html: string[] = [];

  afterEach(() => {
    unmount?.();
    unmount = null;
    closeWorkerSheet();
    closeSheet();
  });

  const sheetHtml = () => document.querySelector(".cmd-worker-sheet")!.outerHTML;

  function shown(): Record<string, unknown> {
    document.body.replaceChildren(document.createElement("div"));
    unmount = mountShell(document.body.firstElementChild as HTMLElement);
    openWorkerSheet(worker);
    const placeholder = document.querySelector<HTMLTextAreaElement>(".cmd-text")!.placeholder;
    html = [document.querySelector(".side")!.outerHTML, sheetHtml()];
    openWorkerSheet({ ...worker, id: "w1", name: "fix-menu", chat: "fix-menu", rivet: undefined });
    html.push(sheetHtml());
    return {
      side: document.querySelector(".side")!.getAttribute("aria-label"),
      placeholder,
      heading: document.querySelector(".cmd-send .cmd-h")!.textContent,
      where: document.querySelector(".cmd-send .sheet-where")!.textContent,
      chat: chatName("rivet"),
    };
  }

  const said = (name: string) => ({
    side: `Chat with ${name}`,
    placeholder: `Ask ${name} anything`,
    heading: `Message ${name} about fix-menu`,
    where: `Goes to ${name} in Chat, tagged fix-menu. He passes it on.`,
    chat: name,
  });

  it("is Rivet on the owner's own machine", async () => {
    await probeCloud();
    expect(shown()).toEqual(said("Rivet"));
    expect(html.join("")).toContain("Ask Rivet anything");
  });

  it("is a hosted agent's own name, with no Rivet in the shell or the worker sheet", async () => {
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    await probeCloud();
    expect(shown()).toEqual(said("Pip"));
    expect(html.join("").match(/.{0,60}Rivet.{0,40}/g)).toBeNull();
  });

  it("is Agent for a hosted agent with no name yet, with no Rivet in the shell or the worker sheet", async () => {
    answers["/cloud/agent"] = () => json({ name: null, setupDone: true, firstPlan: "claude" });
    await probeCloud();
    expect(shown()).toEqual(said("Agent"));
    expect(html.join("").match(/.{0,60}Rivet.{0,40}/g)).toBeNull();
  });

  it("locks the worker sheet's message box while a hosted agent has no plan, its line the way to Connect, and unlocks it once one is connected", async () => {
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    answers["/cloud/connect/status"] = () => json({ claude: false, chatgpt: false });
    vi.stubGlobal("SpeechRecognition", class {});
    await readCloud(changed);
    shown();
    const text = document.querySelector<HTMLTextAreaElement>(".cmd-send .cmd-text")!;
    const send = document.querySelector<HTMLButtonElement>('.cmd-send [data-use="worker.send"]')!;
    const mic = document.querySelector<HTMLButtonElement>(".cmd-send .dictate-mic")!;
    const line = document.querySelector<HTMLAnchorElement>(".cmd-send .sheet-where .noplan-line")!;
    expect([text.disabled, send.disabled, mic.disabled]).toEqual([true, true, true]);
    expect(mic.getAttribute("aria-label")).toBe(`Dictate ${text.getAttribute("aria-label")}`);
    expect(mic.getAttribute("aria-label")).not.toBe("Dictate text");
    expect(document.querySelectorAll(".cmd-send .noplan-line")).toHaveLength(1);
    expect(line.textContent).toBe("Sending is off until Claude or ChatGPT is connected.");
    expect(line.getAttribute("href")).toBe(CONNECT_PATH);
    expect(line.querySelector(".noplan-mark")).not.toBeNull();

    answers["/cloud/connect/status"] = () => json({ claude: true, chatgpt: false });
    await readCloud(changed);
    expect([text.disabled, send.disabled, mic.disabled]).toEqual([false, false, false]);
    expect(document.querySelector(".cmd-send .sheet-where")!.textContent).toBe(said("Pip").where);
  });

  it("locks a card's message box, its mic, photos and Send while a hosted agent has no plan, and unlocks it once one is connected", async () => {
    vi.stubGlobal("SpeechRecognition", class {});
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    answers["/cloud/connect/status"] = () => json({ claude: false, chatgpt: false });
    await readCloud(changed);
    const need = { id: "n-plan", kind: "approval", title: "Card", ask: "Ship it?", rev: "1" } as const;
    document.body.replaceChildren(answerCard(need));
    const parts = () => [".say-text", ".dictate-mic", ".attach-btn", ".say-send"].map((one) => document.querySelector<HTMLButtonElement>(`.say-line ${one}`)!.disabled);
    const line = document.querySelector<HTMLAnchorElement>(".say-line .noplan-line")!;
    expect(parts()).toEqual([true, true, true, true]);
    expect([line.hidden, line.textContent, line.getAttribute("href")]).toEqual([false, "Sending is off until Claude or ChatGPT is connected.", CONNECT_PATH]);
    expect(line.querySelector(".noplan-mark")).not.toBeNull();

    answers["/cloud/connect/status"] = () => json({ claude: true, chatgpt: false });
    await readCloud(changed);
    expect(parts()).toEqual([false, false, false, false]);
    expect(line.hidden).toBe(true);
  });

  it("locks a question card's Send answer with its box, and unlocks it once a plan is connected", async () => {
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    answers["/cloud/connect/status"] = () => json({ claude: false, chatgpt: false });
    await readCloud(changed);
    const need = { id: "n-question", kind: "question", title: "Card", ask: "Which colour?", rev: "1" } as const;
    document.body.replaceChildren(answerCard(need));
    const answer = () => document.querySelector<HTMLButtonElement>('[data-use="cards.send-answer"]')!;
    expect([answer().disabled, document.querySelector<HTMLTextAreaElement>(".say-text")!.disabled]).toEqual([true, true]);

    answers["/cloud/connect/status"] = () => json({ claude: true, chatgpt: false });
    await readCloud(changed);
    expect([answer().disabled, document.querySelector<HTMLTextAreaElement>(".say-text")!.disabled]).toEqual([false, false]);
  });

  it("is Rivet again once the machine is the owner's own", async () => {
    answers["/cloud/agent"] = () => json({ name: "Pip", setupDone: true, firstPlan: "claude" });
    await probeCloud();
    resetCloud();
    expect([RIVET_NAME, agentName()]).toEqual(["Rivet", "Rivet"]);
  });
});
