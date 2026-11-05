import { h } from "../dom.js";
import { copyButtons } from "./agents.js";
import { showRivetChat } from "./chat.js";
import { closeSheet, openSheet } from "./sheet.js";

// Rivet's pop-up: a tap on him at his desk opens Copy summary and the way to his chat.

export function openRivetSummary(): void {
  const chat = h(
    "button",
    {
      class: "btn",
      attrs: { type: "button", "data-use": "desks.rivet.chat" },
      on: {
        click: () => {
          closeSheet();
          showRivetChat();
        },
      },
    },
    "Rivet's chat",
  );
  openSheet("Rivet", { mount: (el) => el.append(copyButtons()), unmount: () => {} }, "Close", chat, { className: "rivet-sum", use: "rivet-summary" });
}
