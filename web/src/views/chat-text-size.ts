// Chat's text size: Small, Medium or Large under the chat's options button, saved on this device and applied at once.
// It sets the page's data-chat-text: command.css sizes a line's words, its reply quote and the box he types in from it,
// and styles.css's --text-scale sizes every other word in the app.
import { h } from "../dom.js";

export type ChatTextSize = "s" | "m" | "l";

const KEY = "rivet.chat.textSize";
/** Medium until he picks another. */
export const DEFAULT_CHAT_TEXT_SIZE: ChatTextSize = "m";
/** The size picked on this visit: it holds even when storage refuses to save it. */
let picked: ChatTextSize | null = null;
export const CHAT_TEXT_SIZES: readonly { size: ChatTextSize; label: string }[] = [
  { size: "s", label: "Small" },
  { size: "m", label: "Medium" },
  { size: "l", label: "Large" },
];

function isSize(value: unknown): value is ChatTextSize {
  return value === "s" || value === "m" || value === "l";
}

export function readChatTextSize(): ChatTextSize {
  if (picked) return picked;
  try {
    const saved = localStorage.getItem(KEY);
    return isSize(saved) ? saved : DEFAULT_CHAT_TEXT_SIZE;
  } catch {
    return DEFAULT_CHAT_TEXT_SIZE;
  }
}

export function applyChatTextSize(size: ChatTextSize = readChatTextSize()): void {
  document.documentElement.dataset.chatText = size;
}

/** styles.css's --text-scale now (Medium 1), for text drawn by script where CSS cannot reach it: a canvas. */
export function textScale(): number {
  const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-scale"));
  return scale > 0 ? scale : 1;
}

export function setChatTextSize(size: ChatTextSize): void {
  picked = size;
  try {
    localStorage.setItem(KEY, size);
  } catch {
    // Private mode or full storage: `picked` keeps the size for this visit.
  }
  applyChatTextSize(size);
}

/** The menu's "Text size" row: three choices, the saved one pressed. */
export function chatTextSizePicker(): HTMLElement {
  const buttons = CHAT_TEXT_SIZES.map(({ size, label }) =>
    h(
      "button",
      {
        class: `chat-size chat-size-${size}`,
        attrs: { type: "button", role: "menuitemradio", "aria-checked": "false", "data-use": `chat.text-size.${size}` },
        on: { click: () => pick(size) },
      },
      label,
    ),
  );
  const paint = () => {
    const now = readChatTextSize();
    CHAT_TEXT_SIZES.forEach(({ size }, i) => buttons[i]!.setAttribute("aria-checked", String(size === now)));
  };
  function pick(size: ChatTextSize): void {
    setChatTextSize(size);
    paint();
  }
  paint();
  return h(
    "div",
    { class: "chat-size-row", attrs: { role: "group", "aria-label": "Text size" } },
    h("span", { class: "chat-size-title" }, "Text size"),
    h("div", { class: "chat-size-choices" }, ...buttons),
  );
}
