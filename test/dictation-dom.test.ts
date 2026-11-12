// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IDLE_MS, stopDictation, withMic } from "../web/src/dictation.js";
import { mountToasts } from "../web/src/views/toast.js";

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
  /** The hidden frames on the page when this recognition was made. */
  frames = document.querySelectorAll("iframe.dictate-frame").length;
  constructor() {
    FakeRecognition.made.push(this);
  }
  start() {
    if (FakeRecognition.refuse) throw new Error("InvalidStateError");
    this.listening = true;
  }
  /** The browser ending this recognition by itself, as iOS does at every pause. */
  end() {
    this.listening = false;
    this.onend?.();
  }
  abort() {
    this.listening = false;
  }
  /** Every result so far, as the browser reports them: the last may be interim. */
  hear(...parts: string[]) {
    this.onresult?.({ results: parts.map((transcript) => [{ transcript }]) });
  }
}

function field(value = "", label = "Comment"): HTMLTextAreaElement {
  const area = document.createElement("textarea");
  area.setAttribute("aria-label", label);
  area.value = value;
  return area;
}

function mount(area: HTMLTextAreaElement): HTMLButtonElement {
  document.body.append(withMic(area));
  return area.parentElement!.querySelector<HTMLButtonElement>(".dictate-mic")!;
}

const last = () => FakeRecognition.made.at(-1)!;

beforeEach(() => {
  FakeRecognition.made = [];
  FakeRecognition.refuse = false;
  document.body.replaceChildren();
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
});

afterEach(() => {
  stopDictation();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voice typing", () => {
  it("has no mic where the browser can neither record nor recognise speech", () => {
    vi.unstubAllGlobals();
    const area = field();
    expect(withMic(area)).toBe(area);
    document.body.append(area);
    expect(document.querySelector(".dictate-mic")).toBeNull();
  });

  it("uses the standard SpeechRecognition where there is one", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    mount(field()).click();
    expect(last().listening).toBe(true);
  });

  it("puts the transcript at the cursor as editable text, live as it is heard", () => {
    const area = field("Make it faster");
    const mic = mount(area);
    const inputs: string[] = [];
    area.addEventListener("input", () => inputs.push(area.value));
    area.focus();
    area.setSelectionRange(8, 8);
    mic.click();
    const recognition = last();
    expect(recognition.continuous).toBe(true);
    expect(recognition.interimResults).toBe(true);

    recognition.hear("a bit");
    expect(area.value).toBe("Make it a bit faster");
    recognition.hear("a bit", " more");
    expect(area.value).toBe("Make it a bit more faster");
    expect(area.selectionStart).toBe("Make it a bit more ".length);
    // The field's own input handler sees each change, as it would typing.
    expect(inputs).toEqual(["Make it a bit faster", "Make it a bit more faster"]);
  });

  it("replaces a selection and adds a space after existing text", () => {
    const area = field("Ship it now");
    const mic = mount(area);
    area.focus();
    area.setSelectionRange(8, 11);
    mic.click();
    last().hear("tomorrow");
    expect(area.value).toBe("Ship it tomorrow");

    const empty = field("Looks good.");
    const other = mount(empty);
    other.click();
    last().hear("Merge it");
    expect(empty.value).toBe("Looks good. Merge it");
  });

  it("replaces a selection made before focus moved to the mic by keyboard", () => {
    const area = field("Ship it now");
    const mic = mount(area);
    area.focus();
    area.setSelectionRange(8, 11);
    mic.focus();
    expect(document.activeElement).toBe(mic);
    mic.click();
    last().hear("tomorrow");
    expect(area.value).toBe("Ship it tomorrow");
  });

  it("puts a replaced selection back when an interim guess is withdrawn", () => {
    const area = field("Ship it now");
    const mic = mount(area);
    area.focus();
    area.setSelectionRange(8, 11);
    mic.click();
    last().hear("tom");
    expect(area.value).toBe("Ship it tom");
    last().hear();
    last().onend?.();
    expect(area.value).toBe("Ship it now");
  });

  it("stops, and brings nothing back, when the app clears the field under it", () => {
    const area = field("First");
    const mic = mount(area);
    mic.click();
    // A Send succeeding clears the box in code, which fires no input event.
    area.value = "";
    last().hear("Second");
    expect(area.value).toBe("");
    expect(last().listening).toBe(false);
    expect(mic.getAttribute("aria-pressed")).toBe("false");
  });

  it("stops when the app goes to the background", () => {
    const area = field();
    const mic = mount(area);
    mic.click();
    last().hear("Keep");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    hidden.mockRestore();
    expect(last().listening).toBe(false);
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    expect(area.value).toBe("Keep");
  });

  it("keeps within the field's length limit", () => {
    const area = field("abc");
    area.maxLength = 8;
    mount(area).click();
    last().hear("one two three");
    expect(area.value).toBe("abc one");
  });

  it("shows it is listening, and a second tap stops it and keeps the text", () => {
    const area = field();
    const mic = mount(area);
    const wrap = area.parentElement!;
    const status = wrap.querySelector<HTMLElement>(".dictate-status")!;
    expect(status.hidden).toBe(true);
    expect(mic.getAttribute("aria-pressed")).toBe("false");

    mic.click();
    expect(mic.classList.contains("listening")).toBe(true);
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.getAttribute("aria-label")).toBe("Stop dictation");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("tap the mic to stop");

    const recognition = last();
    recognition.hear("Bluer ice");
    mic.click();
    expect(recognition.listening).toBe(false);
    expect(mic.classList.contains("listening")).toBe(false);
    expect(mic.getAttribute("aria-label")).toBe("Dictate Comment");
    expect(status.hidden).toBe(true);
    // A late result after the stop changes nothing.
    recognition.hear("Bluer ice", " please");
    expect(area.value).toBe("Bluer ice");

    mic.click();
    expect(FakeRecognition.made).toHaveLength(2);
    expect(last().listening).toBe(true);
  });

  it("stops when the field loses focus, when you type and when the field goes, and never starts again by itself", async () => {
    const area = field();
    const mic = mount(area);
    const listening = () => mic.classList.contains("listening");

    mic.click();
    area.blur();
    expect(listening()).toBe(false);
    expect(last().listening).toBe(false);
    last().end();
    expect(FakeRecognition.made).toHaveLength(1);

    mic.click();
    area.value = "typed";
    area.dispatchEvent(new Event("input"));
    expect(listening()).toBe(false);

    mic.click();
    const recognition = last();
    area.parentElement!.remove();
    await Promise.resolve();
    expect(recognition.listening).toBe(false);
  });

  it("listens in one field at a time", () => {
    const first = field("", "Comment");
    const second = field("", "Your answer");
    const firstMic = mount(first);
    const secondMic = mount(second);

    firstMic.click();
    const one = last();
    secondMic.click();
    const two = last();
    expect(one.listening).toBe(false);
    expect(firstMic.classList.contains("listening")).toBe(false);
    expect(two.listening).toBe(true);
    expect(secondMic.classList.contains("listening")).toBe(true);

    two.hear("hello");
    expect(second.value).toBe("hello");
    expect(first.value).toBe("");
  });

  it("says so when the microphone is not allowed", () => {
    mountToasts(document.body);
    const area = field();
    const mic = mount(area);
    mic.click();
    last().onerror?.({ error: "not-allowed" });
    expect(mic.classList.contains("listening")).toBe(false);
    expect(document.body.textContent).toContain("Allow the microphone");
  });

  it("keeps the caret in the field when the mic is pressed", () => {
    const area = field();
    const mic = mount(area);
    const press = new Event("mousedown", { cancelable: true });
    mic.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    // A prevented pointerdown would cost the tap its click on an iPhone.
    const touch = new Event("pointerdown", { cancelable: true });
    mic.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(false);
  });
});

describe("voice typing across pauses", () => {
  // Some phone engines send the whole sentence so far with each result, so a field that
  // adds each one reads "open the list open the list open the list of …".
  it("writes mobile engines' (Android Chrome, iOS) cumulative results once", () => {
    const area = field();
    mount(area).click();
    const said: string[] = [];
    for (const words of ["open the list", "open the list", "open the list of", "open the list of new", "open the list of new cards"]) {
      said.push(words);
      last().hear(...said);
    }
    expect(area.value).toBe("open the list of new cards");
  });

  it("writes Android Chrome's cumulative results once when case or spacing differ, and a repeated final once", () => {
    const area = field();
    mount(area).click();
    const first = last();
    first.hear("Open the");
    first.hear("Open the", " open the lis");
    first.hear("Open the", " open the lis", " open the list");
    expect(area.value).toBe("open the list");
    first.hear("Open the", " open the lis", " open the list", "  open  the list of new cards ");
    expect(area.value).toBe("open the list of new cards");
    // The final result comes again after the interim one.
    first.hear("Open the list of new cards", " Open the list of new cards");
    expect(area.value).toBe("Open the list of new cards");
    first.end();

    const second = last();
    // Punctuation added to a repeated word is still the same word.
    second.hear("now", " Now.");
    expect(area.value).toBe("Open the list of new cards Now.");
    second.hear("now", " Now sort them");
    expect(area.value).toBe("Open the list of new cards Now sort them");
  });

  it("writes iOS's cumulative results once across a pause and a restart, revisions included", () => {
    const area = field();
    mount(area).click();
    const first = last();
    first.hear("I scream");
    // A revision of the first words replaces them rather than adding.
    first.hear("I scream", "ice cream please");
    expect(area.value).toBe("ice cream please");
    first.hear("I scream", "ice cream please", "ice cream please for the team");
    expect(area.value).toBe("ice cream please for the team");
    first.end();

    const second = last();
    second.hear("thanks");
    second.hear("thanks", "thanks Rivet");
    expect(area.value).toBe("ice cream please for the team thanks Rivet");
  });

  it("joins desktop Chrome's separate pieces once, across a pause and a restart", () => {
    const area = field();
    mount(area).click();
    const first = last();
    first.hear("open the");
    first.hear("open the", " list");
    first.hear("open the", " list", " of new cards");
    expect(area.value).toBe("open the list of new cards");
    first.end();

    const second = last();
    // Spacing after a piece separates it as well as spacing before the next.
    second.hear("now ", "sort them", " by date");
    expect(area.value).toBe("open the list of new cards now sort them by date");
  });

  it("keeps repeated words inside a piece and words that start another, and each session joins its own pieces", () => {
    const area = field();
    const mic = mount(area);
    mic.click();
    last().hear("very very", " important");
    expect(area.value).toBe("very very important");
    last().hear("I", " insist", " on an", " android phone");
    expect(area.value).toBe("I insist on an android phone");
    mic.click();
    mic.click();
    last().hear("please", " fix it");
    expect(area.value).toBe("I insist on an android phone please fix it");
  });

  it("carries on when the browser ends a recognition at a pause, keeping the words without doubling them", () => {
    const area = field();
    const mic = mount(area);
    mic.click();
    const first = last();
    first.hear("Make the mic");
    first.end();

    expect(FakeRecognition.made).toHaveLength(2);
    const second = last();
    expect(second.listening).toBe(true);
    expect(second.continuous).toBe(true);
    expect(mic.classList.contains("listening")).toBe(true);
    expect(area.value).toBe("Make the mic");

    // The new recognition's results start from nothing again.
    second.hear("stay on");
    expect(area.value).toBe("Make the mic stay on");
    second.hear("stay on", " please");
    expect(area.value).toBe("Make the mic stay on please");
    // A late result from the one that ended writes nothing.
    first.hear("Make the mic", " again");
    expect(area.value).toBe("Make the mic stay on please");
  });

  it("keeps the interim guess on screen when a recognition ends, and writes it only once", () => {
    const area = field();
    mount(area).click();
    const first = last();
    first.hear("hello wor");
    first.end();
    expect(area.value).toBe("hello wor");

    const second = last();
    second.hear("again");
    expect(area.value).toBe("hello wor again");
    // The old recognition's final version of the guess comes too late to count.
    first.hear("hello world");
    expect(area.value).toBe("hello wor again");
    // The new one withdrawing its own guess leaves the kept words alone.
    second.hear();
    expect(area.value).toBe("hello wor");
  });

  it("carries on at the cursor mid-text, spacing the words from what follows", () => {
    const area = field("Make it faster");
    const mic = mount(area);
    area.focus();
    area.setSelectionRange(8, 8);
    mic.click();
    last().hear("a bit");
    last().end();
    expect(area.value).toBe("Make it a bit faster");
    last().hear("more");
    expect(area.value).toBe("Make it a bit more faster");
    expect(area.selectionStart).toBe("Make it a bit more ".length);
    last().hear();
    expect(area.value).toBe("Make it a bit faster");
  });

  it("carries on after a pause with nothing heard, still replacing the selection", () => {
    const area = field("Ship it now");
    const mic = mount(area);
    area.focus();
    area.setSelectionRange(8, 11);
    mic.click();
    last().onerror?.({ error: "no-speech" });
    last().end();
    expect(mic.classList.contains("listening")).toBe(true);
    last().onerror?.({ error: "aborted" });
    last().end();
    last().hear("tomorrow");
    expect(area.value).toBe("Ship it tomorrow");
  });

  it("a tap to stop is final: nothing starts again", () => {
    const area = field();
    const mic = mount(area);
    mic.click();
    const recognition = last();
    recognition.hear("Done");
    mic.click();
    recognition.end();
    expect(FakeRecognition.made).toHaveLength(1);
    expect(mic.classList.contains("listening")).toBe(false);
    expect(area.value).toBe("Done");
  });

  it("off is off: each dictation listens in a hidden frame of its own, and Off removes it", () => {
    // WebKit shows the mic in use until the document that made the recognition goes
    // away; abort() alone left Safari's mic on after Off.
    // Each frame's window has a recognition of its own, as a browser's does.
    class FrameRecognition extends FakeRecognition {}
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue({ webkitSpeechRecognition: FrameRecognition } as unknown as Window);
    const frames = () => document.querySelectorAll<HTMLIFrameElement>("iframe.dictate-frame");
    const area = field();
    const mic = mount(area);
    expect(frames()).toHaveLength(0);
    mic.click();
    last().hear("one");
    last().end();
    expect(FakeRecognition.made.map((recognition) => recognition.frames)).toEqual([1, 1]);
    expect(FakeRecognition.made.every((recognition) => recognition instanceof FrameRecognition)).toBe(true);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.hidden).toBe(true);
    mic.click();
    expect(frames()).toHaveLength(0);
    expect(FakeRecognition.made.every((recognition) => !recognition.listening)).toBe(true);
    expect(mic.getAttribute("aria-pressed")).toBe("false");

    const other = field("", "Note");
    const second = mount(other);
    mic.click();
    second.click();
    expect(frames()).toHaveLength(1);
    other.blur();
    expect(frames()).toHaveLength(0);
  });

  it("stops after a minute with no words, and each word resets the minute", () => {
    vi.useFakeTimers();
    const area = field();
    const mic = mount(area);
    mic.click();
    vi.advanceTimersByTime(IDLE_MS - 1_000);
    last().hear("still here");
    vi.advanceTimersByTime(IDLE_MS - 1_000);
    expect(mic.classList.contains("listening")).toBe(true);
    // Pauses that restart the recognition do not count as words.
    last().end();
    vi.advanceTimersByTime(2_000);
    expect(mic.classList.contains("listening")).toBe(false);
    expect(last().listening).toBe(false);
    expect(area.value).toBe("still here");
  });

  it("stops when the app clears the field between recognitions", () => {
    const area = field();
    const mic = mount(area);
    mic.click();
    last().hear("Sent");
    area.value = "";
    last().end();
    expect(FakeRecognition.made).toHaveLength(1);
    expect(mic.classList.contains("listening")).toBe(false);
    expect(area.value).toBe("");
  });

  it("stops instead of spinning when recognitions keep ending with nothing heard", () => {
    const area = field();
    const mic = mount(area);
    mic.click();
    for (let i = 0; i < 4; i += 1) last().end();
    last().hear("words");
    for (let i = 0; i < 4; i += 1) last().end();
    expect(mic.classList.contains("listening")).toBe(true);
    last().end();
    expect(mic.classList.contains("listening")).toBe(false);
    expect(FakeRecognition.made).toHaveLength(9);
    expect(area.value).toBe("words");
  });

  it("stops when a fresh recognition cannot start, or the microphone fails", () => {
    const area = field();
    const mic = mount(area);
    mic.click();
    FakeRecognition.refuse = true;
    last().end();
    expect(mic.classList.contains("listening")).toBe(false);
    FakeRecognition.refuse = false;

    mic.click();
    last().onerror?.({ error: "audio-capture" });
    expect(mic.classList.contains("listening")).toBe(false);
    const made = FakeRecognition.made.length;
    last().end();
    expect(FakeRecognition.made).toHaveLength(made);
  });
});
