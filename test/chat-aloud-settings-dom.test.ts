// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { autoSpeak, setAutoSpeak } from "../web/src/voice.js";
import { voiceSettings } from "../web/src/views/voice-settings.js";

// Read-aloud on tap: Chat's auto-speak starts off.

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

afterEach(() => vi.unstubAllGlobals());

describe("auto-speak", () => {
  it("starts off, even on a phone that had the old switch on", () => {
    localStorage.setItem("rivet.speak", "1");
    expect(autoSpeak()).toBe(false);
    setAutoSpeak(true);
    expect(autoSpeak()).toBe(true);
    setAutoSpeak(false);
    expect(autoSpeak()).toBe(false);
  });
});

describe("voiceSettings", () => {
  it("has the auto-speak switch and the speech engine, and no budget", () => {
    vi.stubGlobal("webkitSpeechRecognition", class {});
    const panel = voiceSettings();
    document.body.append(panel);
    const toggle = panel.querySelector<HTMLButtonElement>(".voice-auto")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toBe("Read new messages aloud: Off");
    toggle.click();
    expect(autoSpeak()).toBe(true);
    expect(toggle.textContent).toBe("Read new messages aloud: On");
    expect(panel.querySelector(".voice-engine")!.textContent).toMatch(/your phone's own speech engine/);
    expect(panel.querySelector(".voice-budget")).toBeNull();
  });
});
