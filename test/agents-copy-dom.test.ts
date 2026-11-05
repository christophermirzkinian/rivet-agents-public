// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

import { COPIED_MS, copySummary } from "../web/src/views/agents-copy.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function mount(text = "Here's the summary", other = "Short update") {
  const el = copySummary([
    { label: "Copy summary", text: () => text },
    { label: "Copy short", text: () => other },
  ]);
  document.body.append(el);
  const [button, otherButton] = el.querySelectorAll<HTMLButtonElement>(".agents-copy-btn");
  return {
    button: button!,
    otherButton: otherButton!,
    note: el.querySelector<HTMLElement>(".agents-copy-note")!,
    manual: el.querySelector<HTMLTextAreaElement>(".agents-copy-manual")!,
  };
}

it("copies the summary read at the tap and says Copied for two seconds", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const { button, note, manual } = mount("• one\n• two");
  button.click();
  await flush();
  expect(writeText).toHaveBeenCalledWith("• one\n• two");
  expect(note.textContent).toBe("Copied");
  expect(manual.hidden).toBe(true);
  vi.useFakeTimers();
  button.click();
  await vi.advanceTimersByTimeAsync(COPIED_MS - 10);
  expect(note.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(20);
  expect(note.textContent).toBe("");
});

it("copies each button's own text", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const { button, otherButton, note } = mount("full", "short only");
  expect([button.textContent, otherButton.textContent]).toEqual(["Copy summary", "Copy short"]);
  otherButton.click();
  await flush();
  expect(writeText).toHaveBeenLastCalledWith("short only");
  expect(note.textContent).toBe("Copied");
  button.click();
  await flush();
  expect(writeText).toHaveBeenLastCalledWith("full");
});

it("falls back to the copy command when the clipboard is refused", async () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  const exec = vi.fn().mockReturnValue(true);
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
  const { button, note } = mount();
  button.click();
  await flush();
  expect(exec).toHaveBeenCalledWith("copy");
  expect(note.textContent).toBe("Copied");
  expect(document.querySelector(".agents-copy-area")).toBeNull();
});

it("shows the text selected to copy by hand when both ways are refused", async () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
  Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
  const { button, note, manual } = mount("• by hand");
  button.click();
  await flush();
  expect(note.textContent).toBe("Couldn't copy: hold the text below");
  expect(manual.hidden).toBe(false);
  expect(manual.value).toBe("• by hand");
});
