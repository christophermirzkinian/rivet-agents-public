// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { probeCloud, resetCloud } from "../web/src/cloud-agent.js";
import { endSession } from "../web/src/session.js";
import { app } from "../web/src/state.js";
import { loadMindSetup, paintMindSetup, parseMindSetup } from "../web/src/views/mind-setup.js";
import { mountShell } from "../web/src/views/shell.js";

// The Mind page on a hosted machine with no map: five questions with Back, then a true-or-false list with neither chosen.

const q = (id: string, title: string) => ({ id, title, options: [{ id: "a", title: `${id} A`, note: "First" }, { id: "b", title: `${id} B`, note: "" }] });
const BODY = {
  questions: [q("write", "How should {agent} write to you?"), q("check", "Two?"), q("code", "Three?"), q("help", "Four?"), q("update", "Five?")],
  list: [
    { title: "Notes to keep", lines: [{ id: "asked", say: "I want a list" }, { id: "decisions", say: "I want my decisions" }] },
    { title: "Skills", lines: [{ id: "week", say: "I want a summary" }] },
  ],
};
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

let saved: string[] = [];
let state: Record<string, unknown> = {};
let answerSet: () => Promise<Response>;
let mind: () => Promise<Response>;
let unmount: (() => void) | null = null;

const settle = async () => {
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((done) => setTimeout(done, 0));
  }
};
const open = async () => {
  app.tab = "more";
  app.morePage = "mind";
  unmount = mountShell(document.body.firstElementChild as HTMLElement);
  await settle();
};
const titleText = () => document.querySelector(".ms-title")?.textContent;
const find = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".mind-setup button")].find((one) => (one.getAttribute("aria-label") ?? one.textContent ?? "").startsWith(text))!;
const tap = async (text: string) => {
  find(text).click();
  await settle();
};
const pressed = () => [...document.querySelectorAll('.mind-setup [aria-pressed="true"]')].map((one) => one.getAttribute("aria-label") ?? one.textContent);

beforeEach(async () => {
  saved = [];
  state = { kind: "none", answers: {}, yes: [], no: [] };
  answerSet = () => json({ result: "set", codex: true });
  mind = () => json({ ...BODY, state });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const at = new URL(String(url), "http://x").pathname;
      if (at === "/cloud/agent") return json({ name: "Pip", setupDone: true, firstPlan: "claude" });
      if (at === "/cloud/mind") return mind();
      if (at === "/cloud/mind/set") {
        saved.push(String(init!.body));
        return answerSet();
      }
      if (at === "/api/mind") return json({ graph: null, receivedAt: null });
      return new Promise(() => {});
    }),
  );
  document.body.replaceChildren(document.createElement("div"));
});

afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  endSession();
  resetCloud();
  app.tab = "cards";
  app.morePage = null;
});

describe("the mind setup on a hosted machine", () => {
  beforeEach(async () => {
    await probeCloud();
  });

  it("asks five questions, with Back from the second on and the earlier answer still chosen", async () => {
    await open();
    expect(titleText()).toBe("How should Pip write to you?");
    expect(document.querySelector(".ms-count")!.textContent).toBe("1 of 5");
    expect(find("Back")).toBeUndefined();
    expect(pressed()).toEqual([]);
    await tap("write B");
    expect(titleText()).toBe("Two?");
    await tap("Back");
    expect(titleText()).toBe("How should Pip write to you?");
    expect(pressed()).toEqual(["write B"]);
    await tap("write A");
    await tap("Back");
    expect(pressed()).toEqual(["write AFirst"]);
    for (const next of ["Two?", "Three?", "Four?", "Five?"]) {
      await tap("Skip");
      expect(titleText()).toBe(next);
      expect(find("Back")).toBeDefined();
    }
    await tap("update A");
    expect(titleText()).toBe("True or false?");
    await tap("Back");
    expect(titleText()).toBe("Five?");
    expect(pressed()).toEqual(["update AFirst"]);
    expect(saved).toEqual(["id=write&value=b", "id=write&value=a", "id=update&value=a"]);
  });

  it("opens the list with neither chosen, saves each tap, and shows only what is true as on", async () => {
    await open();
    for (let i = 0; i < 5; i++) await tap("Skip");
    expect(titleText()).toBe("True or false?");
    expect(pressed()).toEqual([]);
    await tap("True: I want a list");
    await tap("False: I want my decisions");
    expect(pressed()).toEqual(["True: I want a list", "False: I want my decisions"]);
    expect(saved).toEqual(["id=asked&value=true", "id=decisions&value=false"]);
    await tap("Done");
    expect(titleText()).toBe("What Pip knows");
    expect(document.querySelector(".mind-setup")!.textContent).not.toContain("I want my decisions");
    await tap("Remove: I want a list");
    expect(saved.at(-1)).toBe("id=asked&value=");
    expect(find("Remove")).toBeUndefined();
  });

  it("opens on what it knows once something is answered, and changes one answer", async () => {
    state = { kind: "present", answers: { write: "a" }, yes: ["week"], no: ["asked"] };
    await open();
    expect(titleText()).toBe("What Pip knows");
    await tap("Change: How should Pip");
    expect(pressed()).toEqual(["write AFirst"]);
    await tap("write B");
    expect(titleText()).toBe("What Pip knows");
    expect(saved).toEqual(["id=write&value=b"]);
    await tap("Open the list");
    expect(pressed()).toEqual(["False: I want a list", "True: I want a summary"]);
    await tap("Back");
    expect(titleText()).toBe("What Pip knows");
  });

  it("Skip all saves nothing and leaves the questions there", async () => {
    await open();
    await tap("Skip all");
    expect(titleText()).toBe("Pip doesn't know how you like things done yet");
    expect(saved).toEqual([]);
    await tap("Answer 5 questions");
    expect(titleText()).toBe("How should Pip write to you?");
  });

  it("puts back a tap that did not save, and says so", async () => {
    await open();
    for (let i = 0; i < 5; i++) await tap("Skip");
    answerSet = () => json({ error: "not-saved" }, 500);
    await tap("True: I want a list");
    expect(pressed()).toEqual([]);
    expect(document.querySelector(".ms-note")!.textContent).toBe("That didn't save. Try again.");
    answerSet = () => json({ result: "theirs", codex: false }, 409);
    await tap("True: I want a summary");
    expect(pressed()).toEqual([]);
    expect(document.querySelector(".ms-note")!.textContent).toContain("your own skill");
  });

  it("two quick taps that both fail leave neither chosen, and a repeated one that lands last stays", async () => {
    await open();
    for (let i = 0; i < 5; i++) await tap("Skip");
    answerSet = () => json({}, 500);
    find("True: I want a list").click();
    find("False: I want a list").click();
    await settle();
    expect(pressed()).toEqual([]);
    let n = 0;
    answerSet = () => (n++ ? json({ result: "set" }) : json({}, 500));
    for (const one of ["True", "False", "True"]) find(`${one}: I want a list`).click();
    await settle();
    expect(pressed()).toEqual(["True: I want a list"]);
  });

  it("an answer read before a tap never replaces it, and a tap is sent even where it shows as chosen", async () => {
    state = { kind: "present", answers: {}, yes: ["week"], no: [] };
    await open();
    await tap("Open the list");
    let answer: (r: Response) => void = () => {};
    mind = () => new Promise((done) => (answer = done));
    const reading = loadMindSetup();
    await settle();
    await tap("False: I want a summary");
    answer(await json({ ...BODY, state }));
    await reading;
    paintMindSetup(document.querySelector<HTMLElement>(".mind-setup")!.parentElement!);
    expect(pressed()).toEqual(["False: I want a summary"]);
    await tap("False: I want a summary");
    expect(pressed()).toEqual(["False: I want a summary"]);
    expect(saved).toEqual(["id=week&value=false", "id=week&value=false"]);
  });

  it.each([[["week"]], [[]]])("removes an answer, the last one too, and says so while it is being saved (on: %j)", async (yes) => {
    state = { kind: "present", answers: { write: "a" }, yes, no: [] };
    await open();
    await tap("Change: How should Pip");
    let answer: (r: Response) => void = () => {};
    answerSet = () => new Promise((done) => (answer = done));
    await tap("Remove my answer");
    expect(saved).toEqual(["id=write&value="]);
    expect(document.querySelector(".ms-saving")!.textContent).toContain("Keep this page open");
    answer(await json({ result: "set" }));
    await settle();
    expect(document.querySelector(".ms-saving")!.textContent).toBe("");
    expect(find(yes.length ? "Answer: How should Pip" : "Answer 5 questions")).toBeTruthy();
  });

  it("a save that fails after something else took the page's place leaves that there", async () => {
    await open();
    let answer: (r: Response) => void = () => {};
    answerSet = () => new Promise((done) => (answer = done));
    await tap("write A");
    const setup = document.querySelector(".mind-setup")!;
    const map = document.createElement("div");
    setup.replaceWith(map);
    answer(await json({}, 500));
    await settle();
    expect(map.isConnected).toBe(true);
    expect(document.querySelector(".mind-setup")).toBeNull();
  });

  it("a shorter list of questions read on the last one goes back to what it knows", async () => {
    await open();
    for (let i = 0; i < 4; i++) await tap("Skip");
    mind = () => json({ ...BODY, questions: BODY.questions.slice(0, 4), state });
    await loadMindSetup();
    paintMindSetup(document.querySelector<HTMLElement>(".mind-setup")!.parentElement!);
    expect(titleText()).toBe("Pip doesn't know how you like things done yet");
  });

  it("changes nothing in a block edited by hand", async () => {
    state = { kind: "damaged" };
    await open();
    expect(document.querySelector(".mind-setup")!.textContent).toContain("edited by hand");
    expect(document.querySelectorAll(".mind-setup button")).toHaveLength(0);
  });

  it("an older supervisor keeps today's words; one that can't be read can be asked again", async () => {
    mind = () => json({ error: "not-here" }, 404);
    await open();
    expect(document.querySelector(".mind-note")!.textContent).toMatch(/^Pip hasn't sent its map yet/);
    unmount?.();
    endSession();
    mind = () => json({}, 500);
    await open();
    expect(document.querySelector(".reading-failed-words")!.textContent).toBe("Couldn't load Pip's mind.");
  });
});

it("the owner's own machine never asks for the questions", async () => {
  await open();
  expect(document.querySelector(".mind-note")!.textContent).toMatch(/^Rivet hasn't sent its map yet/);
  expect(document.querySelector(".mind-setup")).toBeNull();
});

it("anything but the whole answer is no setup", () => {
  for (const body of [null, {}, { ...BODY }, { ...BODY, list: [], state }, { questions: "x", list: BODY.list, state }]) expect(parseMindSetup(body)).toBeNull();
  expect(parseMindSetup({ ...BODY, state })!.questions).toHaveLength(5);
});
