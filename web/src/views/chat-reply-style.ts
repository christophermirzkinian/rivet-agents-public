// How Rivet writes his answers: Short, Normal or Detailed under the chat's options button, Normal being how it
// writes now. Saved on this device like the text size; every chat message and card
// answer sent from here carries the pick (Normal carries nothing), and the bridge adds a line for it to Rivet's.
import type { ReplyStyle } from "../../../src/shared/command.js";
import { h } from "../dom.js";

export type ChatReplyStyle = "short" | "normal" | "detailed";

const KEY = "rivet.chat.replyStyle";
/** Normal, how Rivet writes now, until he picks another. */
export const DEFAULT_CHAT_REPLY_STYLE: ChatReplyStyle = "normal";
/** The style picked on this visit: it holds even when storage refuses to save it. */
let picked: ChatReplyStyle | null = null;
export const CHAT_REPLY_STYLES: readonly { style: ChatReplyStyle; label: string }[] = [
  { style: "short", label: "Short" },
  { style: "normal", label: "Normal" },
  { style: "detailed", label: "Detailed" },
];

function isStyle(value: unknown): value is ChatReplyStyle {
  return value === "short" || value === "normal" || value === "detailed";
}

export function readChatReplyStyle(): ChatReplyStyle {
  if (picked) return picked;
  try {
    const saved = localStorage.getItem(KEY);
    return isStyle(saved) ? saved : DEFAULT_CHAT_REPLY_STYLE;
  } catch {
    return DEFAULT_CHAT_REPLY_STYLE;
  }
}

export function setChatReplyStyle(style: ChatReplyStyle): void {
  picked = style;
  try {
    localStorage.setItem(KEY, style);
  } catch {
    // Private mode or full storage: `picked` keeps the style for this visit.
  }
}

/** The field a message or card answer sends: none for Normal, so what goes to Rivet stays as it was. */
export function replyStyleField(): { replyStyle?: ReplyStyle } {
  const style = readChatReplyStyle();
  return style === "normal" ? {} : { replyStyle: style };
}

/** The menu's "Reply style" row: three choices, the saved one pressed. */
export function chatReplyStylePicker(): HTMLElement {
  const buttons = CHAT_REPLY_STYLES.map(({ style: choice, label }) =>
    h(
      "button",
      {
        class: "chat-style",
        attrs: { type: "button", role: "menuitemradio", "aria-checked": "false", "data-use": `chat.reply-style.${choice}` },
        on: { click: () => pick(choice) },
      },
      label,
    ),
  );
  const paint = () => {
    const now = readChatReplyStyle();
    CHAT_REPLY_STYLES.forEach(({ style }, i) => buttons[i]!.setAttribute("aria-checked", String(style === now)));
  };
  function pick(style: ChatReplyStyle): void {
    setChatReplyStyle(style);
    paint();
  }
  paint();
  return h(
    "div",
    { class: "chat-size-row", attrs: { role: "group", "aria-label": "Reply style" } },
    h("span", { class: "chat-size-title" }, "Reply style"),
    h("div", { class: "chat-size-choices" }, ...buttons),
  );
}
