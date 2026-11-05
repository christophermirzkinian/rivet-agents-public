// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hold-to-talk on the phone's own engine: Android Chrome's speech
// recognition writes as the owner speaks. Where the browser has none, the keyboard's mic is the way
//.

type Dictation = typeof import("../web/src/dictation.js");

class FakeRecognition {
  static made: FakeRecognition[] = [];
  static refuse = false;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  listening = false;
  constructor() {
    FakeRecognition.made.push(this);
  }
  start() {
    if (FakeRecognition.refuse) throw new Error("InvalidStateError");
    this.listening = true;
  }
  abort() {
    this.listening = false;
  }
  end() {
    this.listening = false;
    this.onend?.();
  }
  hear(...parts: string[]) {
    this.onresult?.({ results: parts.map((transcript) => [{ transcript }]) });
  }
  fail(error: string) {
    this.onerror?.({ error });
  }
}

let dictation: Dictation;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0)).then(() => new Promise((resolve) => setTimeout(resolve, 0)));

function mount(): { area: HTMLTextAreaElement; mic: HTMLButtonElement } {
  const area = document.createElement("textarea");
  area.setAttribute("aria-label", "Say");
  document.body.append(dictation.withMic(area));
  return { area, mic: area.parentElement!.querySelector<HTMLButtonElement>(".dictate-mic")! };
}

async function boot(): Promise<void> {
  vi.resetModules();
  const state = await import("../web/src/state.js");
  state.app.status = { board: { version: 1, updatedAt: null }, bridge: { connected: true, lastSeenAt: null } };
  (await import("../web/src/views/toast.js")).mountToasts(document.body);
  dictation = await import("../web/src/dictation.js");
}

beforeEach(async () => {
  FakeRecognition.made = [];
  FakeRecognition.refuse = false;
  document.body.replaceChildren();
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
  await boot();
});

afterEach(async () => {
  vi.useRealTimers();
  document.body.replaceChildren();
  await settle();
  dictation.stopDictation();
  vi.unstubAllGlobals();
});

describe("hold-to-talk on the phone's engine", () => {
  it("uses the phone's engine, writing interim words live", async () => {
    const { area, mic } = mount();
    expect(dictation.speechEngine()).toBe("phone");
    mic.click();
    await settle();
    expect(FakeRecognition.made).toHaveLength(1);
    FakeRecognition.made[0]!.hear("yes");
    expect(area.value).toBe("yes");
    FakeRecognition.made[0]!.hear("yes ship");
    expect(area.value).toBe("yes ship");
    mic.click();
    expect(area.value).toBe("yes ship");
  });

  it("start() is a press: it starts once and never toggles off", () => {
    const area = document.createElement("textarea");
    document.body.append(area);
    const voice = dictation.dictation(area, () => {})!;
    voice.start();
    voice.start();
    expect(FakeRecognition.made).toHaveLength(1);
    expect(FakeRecognition.made[0]!.listening).toBe(true);
    voice.stop();
    expect(FakeRecognition.made[0]!.listening).toBe(false);
  });

  it("stops silently when the phone's engine refuses to start at the press", async () => {
    FakeRecognition.refuse = true;
    const { mic } = mount();
    mic.click();
    await settle();
    expect(FakeRecognition.made).toHaveLength(1);
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    expect(document.body.textContent).not.toContain("voice typing stopped");
  });

  it("says it stopped when the phone's engine refuses to start again after an end", async () => {
    const { mic } = mount();
    mic.click();
    FakeRecognition.made[0]!.hear("yes");
    FakeRecognition.refuse = true;
    FakeRecognition.made[0]!.end();
    expect(document.body.textContent).toContain("Your phone's voice typing stopped. Tap the mic to try again.");
    expect(mic.getAttribute("aria-pressed")).toBe("false");
  });

  it("says so when the phone's engine fails, and the next tap tries it again", () => {
    const { mic } = mount();
    mic.click();
    FakeRecognition.made[0]!.fail("network");
    expect(document.body.textContent).toContain("Your phone's voice typing stopped. Tap the mic to try again.");
    expect(dictation.speechEngine()).toBe("phone");
    mic.click();
    expect(FakeRecognition.made).toHaveLength(2);
  });

  it("asks for the microphone, and hands nothing over, when it is not allowed", () => {
    const { mic } = mount();
    mic.click();
    FakeRecognition.made[0]!.fail("not-allowed");
    expect(document.body.textContent).toContain("Allow the microphone");
    expect(dictation.speechEngine()).toBe("phone");
  });

  it("says which engine is in use, or none", () => {
    expect(dictation.speechEngine()).toBe("phone");
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    expect(dictation.speechEngine()).toBeNull();
    expect(dictation.dictation(document.createElement("textarea"), () => {})).toBeNull();
  });
});
