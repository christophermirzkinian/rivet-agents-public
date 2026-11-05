import { speechEngine } from "../dictation.js";
import { button, h } from "../dom.js";
import { autoSpeak, canSpeak, setAutoSpeak, stopVoice, testVoice, voiceAvailable, VOICES_EVENT } from "../voice.js";
import { RIVET_NAME } from "../../../src/shared/names.js";

// Settings' one Voice panel: Chat's read-aloud switch, which starts off, whether the phone has a voice to read in and
// a test of it, and the engine the mic uses.

const ENGINES = {
  phone: "Voice typing: your phone's own speech engine, as you speak.",
  none: "Voice typing: this browser has none here. Use your keyboard's mic.",
} as const;

export function voiceSettings(): HTMLElement {
  const toggle = button("", () => {
    setAutoSpeak(!autoSpeak());
    if (!autoSpeak()) stopVoice();
    render();
  }, "big voice-auto", false, "settings.voice.auto");
  const engine = h("p", { class: "panel-text voice-engine" }, ENGINES[speechEngine() ?? "none"]);
  const status = h("p", { class: "panel-text" });
  const test = button("Test voice", () => testVoice(), "big", false, "settings.voice.test");
  const render = () => {
    const on = autoSpeak();
    toggle.setAttribute("aria-pressed", String(on));
    toggle.textContent = on ? "Read new messages aloud: On" : "Read new messages aloud: Off";
    const available = voiceAvailable();
    status.textContent = available
      ? `Chat reads ${RIVET_NAME}'s messages aloud in your phone's own voice, in Australian or British English.`
      : canSpeak()
        ? "Your phone has no Australian or British English voice, so Chat stays silent. Add one in your phone's text-to-speech settings."
        : "This browser can't read aloud, so Chat stays silent.";
    test.disabled = !available;
  };
  render();
  // The phone lists its voices a moment after the page loads, sometimes over several updates: follow them until one
  // fits or the panel is gone.
  if (!voiceAvailable() && canSpeak()) {
    const follow = () => {
      if (status.isConnected) render();
      if (!status.isConnected || voiceAvailable()) window.removeEventListener(VOICES_EVENT, follow);
    };
    window.addEventListener(VOICES_EVENT, follow);
  }
  return h(
    "section",
    { class: "panel box voice-settings" },
    h("h3", { class: "panel-title" }, "Voice"),
    h("p", { class: "panel-text" }, `Read aloud starts off. On, Chat reads each new message from ${RIVET_NAME} in your phone's voice.`),
    toggle,
    status,
    test,
    engine,
  );
}
