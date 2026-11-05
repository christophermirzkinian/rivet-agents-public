// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DEFAULT_PUSH = {
  enabled: false,
  start: "22:00",
  end: "07:00",
  breakthrough: { gameDown: true, deployFailed: true, capHit: true },
  held: 0,
  quietNow: false,
};

let calls: { url: string; body?: unknown }[] = [];
/** Every utterance handed to the device's speech voice, empty ones included. */
let uttered: FakeUtterance[] = [];
let cancels = 0;
let voices: FakeVoice[] = [];
let synth: FakeSynth;

interface FakeVoice {
  name: string;
  lang: string;
  localService: boolean;
}

const voice = (name: string, lang: string, localService = true): FakeVoice => ({ name, lang, localService });

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

class FakeUtterance {
  voice: FakeVoice | null = null;
  lang = "";
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

class FakeSynth extends EventTarget {
  getVoices = () => voices;
  cancel = () => {
    cancels += 1;
  };
  speak = (utterance: FakeUtterance) => {
    uttered.push(utterance);
  };
  /** The phone has listed its voices (Chrome does, a moment after the page loads). */
  list(next: FakeVoice[]) {
    voices = next;
    this.dispatchEvent(new Event("voiceschanged"));
  }
}

/** The voice module the running test loaded; afterEach stops it, so no line of one test plays into the next. */
let loadedVoice: typeof import("../web/src/voice.js") | null = null;

async function load() {
  vi.resetModules();
  const state = await import("../web/src/state.js");
  state.app.status = { board: { version: 1, updatedAt: null }, bridge: { connected: true, lastSeenAt: null } };
  loadedVoice = await import("../web/src/voice.js");
  return { state, voice: loadedVoice, settings: await import("../web/src/views/settings.js") };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
/** What the phone was asked to say, the empty iOS unlock utterance left out. */
const said = () => uttered.filter((utterance) => utterance.text !== "");

beforeEach(() => {
  calls = [];
  uttered = [];
  cancels = 0;
  voices = [voice("Karen", "en-AU")];
  localStorage.clear();
  document.body.replaceChildren();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/settings/push") return Promise.resolve(json(DEFAULT_PUSH));
    return Promise.resolve(json({ error: "not found" }, 404));
  });
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  synth = new FakeSynth();
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
});

afterEach(() => {
  loadedVoice?.stopVoice();
  loadedVoice = null;
  Reflect.deleteProperty(window, "speechSynthesis");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Voice panel", () => {
  const panel = async () => {
    const { settings } = await load();
    const root = document.createElement("div");
    document.body.append(root);
    settings.mount(root);
    await settle();
    const test = () => [...root.querySelectorAll("button")].find((b) => b.textContent === "Test voice")!;
    return { root, test, unmount: () => settings.unmount() };
  };

  it("says the phone's own voice reads aloud, with no voice choice", async () => {
    voices = [voice("Karen", "en-AU")];
    const { root, test, unmount } = await panel();
    expect(root.querySelector('input[name="voice"]')).toBeNull();
    expect(root.textContent).toContain("in your phone's own voice, in Australian or British English");
    expect(test().disabled).toBe(false);
    unmount();
  });

  it("says Chat stays silent, quietly, when the phone has only other accents", async () => {
    voices = [voice("Samantha", "en-US"), voice("Thomas", "fr-FR")];
    const { root, test, unmount } = await panel();
    expect(root.textContent).toContain("Your phone has no Australian or British English voice, so Chat stays silent.");
    expect(test().disabled).toBe(true);
    unmount();
  });

  it("says the browser can't read aloud when it has no speech synthesis", async () => {
    Reflect.deleteProperty(window, "speechSynthesis");
    const { root, test, unmount } = await panel();
    expect(root.textContent).toContain("This browser can't read aloud, so Chat stays silent.");
    expect(test().disabled).toBe(true);
    unmount();
  });

  it("follows the phone's voice list when it arrives after the page", async () => {
    voices = [];
    const { root, test, unmount } = await panel();
    expect(root.textContent).toContain("no Australian or British English voice");
    expect(test().disabled).toBe(true);
    synth.list([voice("Daniel", "en-GB")]);
    expect(root.textContent).toContain("in Australian or British English");
    expect(test().disabled).toBe(false);
    unmount();
  });

  it("keeps following when the first list has only other accents and a later one adds British English", async () => {
    voices = [];
    const { root, test, unmount } = await panel();
    synth.list([voice("Samantha", "en-US")]);
    expect(test().disabled).toBe(true);
    synth.list([voice("Samantha", "en-US"), voice("Daniel", "en-GB")]);
    expect(root.textContent).toContain("in Australian or British English");
    expect(test().disabled).toBe(false);
    unmount();
  });

  it("Test voice speaks the sample line in the phone's voice", async () => {
    const { root, test, unmount } = await panel();
    test().click();
    expect(said().map((utterance) => utterance.text)).toEqual(["Hi. This is how I sound reading your messages."]);
    expect(root.textContent).not.toContain("/api/tts");
    unmount();
  });
});

describe("Read-aloud", () => {
  it("speaks in the Australian voice over British and American ones", async () => {
    voices = [voice("Samantha", "en-US"), voice("Daniel", "en-GB"), voice("Karen", "en-AU")];
    const { voice: v } = await load();
    v.say("G'day you.");
    expect(said()).toHaveLength(1);
    expect(said()[0]!.voice).toBe(voices[2]);
    expect(said()[0]!.lang).toBe("en-AU");
    expect(said()[0]!.text).toBe("G'day you.");
  });

  it("falls back to British when there is no Australian voice, and never to American", async () => {
    voices = [voice("Samantha", "en-US"), voice("Daniel", "en-GB")];
    const { voice: v } = await load();
    v.say("Morning.");
    expect(said()[0]!.voice).toBe(voices[1]);
    expect(said()[0]!.lang).toBe("en-GB");
  });

  it("accepts a language written with an underscore or in other case", async () => {
    voices = [voice("Samantha", "en-US"), voice("Daniel", "en_GB")];
    const { voice: v } = await load();
    v.say("Morning.");
    expect(said()[0]!.voice).toBe(voices[1]);
    expect(said()[0]!.lang).toBe("en_GB");

    voices = [voice("Samantha", "en-US"), voice("Karen", "EN_au")];
    v.say("Again.");
    expect(said()[1]!.voice).toBe(voices[1]);
  });

  it("prefers the on-device voice within an accent", async () => {
    voices = [voice("Online", "en-AU", false), voice("Offline", "en-AU", true), voice("Daniel", "en-GB", true)];
    const { voice: v } = await load();
    v.say("Hello.");
    expect(said()[0]!.voice).toBe(voices[1]);

    voices = [voice("Online", "en-AU", false), voice("Daniel", "en-GB", true)];
    v.say("Hello again.");
    expect(said()[1]!.voice).toBe(voices[0]);
  });

  it("stays silent, without an error, when the phone has only other voices", async () => {
    voices = [voice("Samantha", "en-US"), voice("Thomas", "fr-FR"), voice("Anna", "de-DE")];
    const { voice: v } = await load();
    expect(() => v.say("Anyone there?")).not.toThrow();
    expect(uttered).toEqual([]);
    expect(v.voiceAvailable()).toBe(false);
    expect(v.canSpeak()).toBe(true);
  });

  it("does nothing, and throws nothing, in a browser with no speech synthesis", async () => {
    Reflect.deleteProperty(window, "speechSynthesis");
    const { voice: v } = await load();
    expect(v.canSpeak()).toBe(false);
    expect(v.voiceAvailable()).toBe(false);
    expect(() => v.say("Anyone there?")).not.toThrow();
    expect(() => v.stopVoice()).not.toThrow();
    expect(() => v.testVoice()).not.toThrow();
    expect(() => v.unlockVoice()).not.toThrow();
    expect(uttered).toEqual([]);
  });

  it("skips an empty line", async () => {
    const { voice: v } = await load();
    v.say("   ");
    expect(uttered).toEqual([]);
  });

  it("holds lines until the phone lists its voices, then speaks them in order", async () => {
    voices = [];
    const { voice: v } = await load();
    v.say("First line.");
    v.say("Second line.");
    expect(uttered).toEqual([]);
    synth.list([voice("Daniel", "en-GB")]);
    expect(said().map((utterance) => utterance.text)).toEqual(["First line.", "Second line."]);
    expect(said()[0]!.voice).toBe(voices[0]);
  });

  it("drops a held line once the wait for the voice list is over", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    voices = [];
    const { voice: v } = await load();
    v.say("Too late.");
    await vi.advanceTimersByTimeAsync(v.VOICES_WAIT_MS - 1);
    synth.list([]);
    expect(uttered).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    synth.list([voice("Daniel", "en-GB")]);
    expect(uttered).toEqual([]);

    v.say("On time.");
    expect(said().map((utterance) => utterance.text)).toEqual(["On time."]);
  });

  it("speaks a held line that the list reaches within the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    voices = [];
    const { voice: v } = await load();
    v.say("Just in time.");
    await vi.advanceTimersByTimeAsync(v.VOICES_WAIT_MS - 1);
    synth.list([voice("Karen", "en-AU")]);
    expect(said().map((utterance) => utterance.text)).toEqual(["Just in time."]);
  });

  it("keeps a held line quiet when the list arrives with no Australian or British voice", async () => {
    voices = [];
    const { voice: v } = await load();
    v.say("Silent line.");
    synth.list([voice("Samantha", "en-US")]);
    expect(uttered).toEqual([]);
  });

  it("cuts a long reply into pieces of at most 250 characters, at sentence ends", async () => {
    const { voice: v } = await load();
    const text = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} has news about the Floor and the Feed today.`).join(" ");
    v.say(text);
    const pieces = said().map((utterance) => utterance.text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= 250 && piece.endsWith("."))).toBe(true);
    expect(pieces.join(" ")).toBe(text);
    expect(said().every((utterance) => utterance.voice === voices[0] && utterance.lang === "en-AU")).toBe(true);
  });

  it("cuts a long run with no sentence end at a space, and never above 250", async () => {
    const { voice: v } = await load();
    const text = Array.from({ length: 120 }, () => "word").join(" ");
    v.say(text);
    const pieces = said().map((utterance) => utterance.text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= 250)).toBe(true);
    expect(pieces.join(" ")).toBe(text);
  });

  it("stop cancels what is speaking and drops the lines still waiting", async () => {
    voices = [];
    const { voice: v } = await load();
    v.say("Waiting line.");
    v.stopVoice();
    expect(cancels).toBe(1);
    synth.list([voice("Karen", "en-AU")]);
    expect(uttered).toEqual([]);
  });

  it("a failing utterance is skipped without a word on screen", async () => {
    const { voice: v } = await load();
    synth.speak = () => {
      throw new Error("synthesis-failed");
    };
    expect(() => v.say("One.")).not.toThrow();
    expect(document.body.textContent).toBe("");
  });

  it("unlocks iOS with one empty utterance, once", async () => {
    const { voice: v } = await load();
    v.unlockVoice();
    v.unlockVoice();
    expect(uttered.map((utterance) => utterance.text)).toEqual([""]);
  });

  it("unlocks on the end of a tap, once", async () => {
    const { voice: v } = await load();
    const remove = v.unlockOnTap();
    document.dispatchEvent(new Event("pointerup"));
    document.dispatchEvent(new Event("click"));
    expect(uttered.map((utterance) => utterance.text)).toEqual([""]);
    remove();
  });

  it("Test voice stops what is speaking and says the sample", async () => {
    const { voice: v } = await load();
    v.testVoice();
    expect(cancels).toBe(1);
    expect(said().map((utterance) => utterance.text)).toEqual(["Hi. This is how I sound reading your messages."]);
  });
});
