// Chat's Send delay: On/Off and 3, 5, 7 or 10 s, with a line saying what it is for. The last row of Chat's options menu. On, a message waits that long after his last line, its
// countdown and Cancel showing, so he can take it back and edit it; Off, each line goes at once. Kept on the server
// (/api/settings/chat-send-delay) so his phone and laptop have the same; read again each time the menu opens.
import { CHAT_SEND_DELAY_SECONDS, DEFAULT_CHAT_SEND_DELAY, type ChatSendDelay } from "../../../src/shared/command.js";
import { agentName } from "../cloud-agent.js";
import * as cmd from "../command-api.js";
import { h } from "../dom.js";
import { sameSession, StaleSession } from "../session.js";
import { flash } from "./toast.js";

const TIMER =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 9v4l2.5 2.5M9 2.5h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

// Every row's saves share one queue and one count: a row Chat has since rebuilt can never send its pick over a newer
// one from the row on screen now, and the row on screen reads only once the saves queued before it have finished.
let saveQueue: Promise<unknown> = Promise.resolve();
let newestSave = 0;

/** The words under the row: what the delay is for, or what Off means. */
export function sendDelayNote(delay: ChatSendDelay, agent = agentName()): string {
  return delay.on
    ? `Gives you a few seconds to cancel or edit a message before it goes to ${agent}.`
    : `Off: each message goes to ${agent} at once, with no Cancel.`;
}

/** The menu's Send delay row, and `refresh`, which reads the saved value again (the menu calls it as it opens).
 * `authFail` takes a failed call first and says whether it handled it (a 401 signs out). */
export function chatSendDelayRow(opts: { authFail?: (error: unknown) => boolean } = {}): { el: HTMLElement; refresh: () => void } {
  // What the row shows, and the last value the server answered with (a failed save goes back to it).
  let delay: ChatSendDelay = { ...DEFAULT_CHAT_SEND_DELAY };
  let confirmed: ChatSendDelay = { ...DEFAULT_CHAT_SEND_DELAY };
  // Saves go one after another (saveQueue); each is numbered, and only the newest repaints.
  let picks = 0;
  let pending = 0;
  // Reads are numbered too: only the newest one's answer counts.
  let reads = 0;
  // Until the server has answered once, a tap would save this row's default over its value, so the row waits.
  let known = false;
  let unread = false;
  const icon = h("span", { class: "chat-delay-icon", attrs: { "aria-hidden": "true" } });
  icon.innerHTML = TIMER;
  const toggle = h(
    "button",
    {
      class: "chat-menu-item chat-delay-switch",
      attrs: { type: "button", role: "menuitemcheckbox", "aria-checked": "true", "data-use": "chat.send-delay.toggle" },
      on: { click: () => save({ ...delay, on: !delay.on }) },
    },
    icon,
    h("span", { class: "chat-menu-grow" }, "Send delay"),
    h("span", { class: "chat-switch", attrs: { "aria-hidden": "true" } }),
  );
  const buttons = CHAT_SEND_DELAY_SECONDS.map((seconds) =>
    h(
      "button",
      {
        class: "chat-style chat-delay-seconds",
        attrs: { type: "button", role: "menuitemradio", "aria-checked": "false", "data-use": `chat.send-delay.${seconds}` },
        on: { click: () => save({ on: true, seconds }) },
      },
      `${seconds} s`,
    ),
  );
  const note = h("p", { class: "chat-delay-note" });
  const paint = () => {
    toggle.setAttribute("aria-checked", String(delay.on));
    toggle.disabled = !known;
    buttons.forEach((button, i) => {
      // Off keeps the kept seconds marked (greyed), so it shows what On brings back.
      button.setAttribute("aria-checked", String(CHAT_SEND_DELAY_SECONDS[i] === delay.seconds));
      button.disabled = !known || !delay.on;
    });
    note.textContent = !known && unread ? "Send delay couldn't be read. Close this menu and open it again." : sendDelayNote(delay);
  };
  const confirm = (saved: ChatSendDelay) => {
    confirmed = saved;
    known = true;
    unread = false;
  };
  // A 401 has signed out, or the session changed under a call: saves still queued don't go, until a read answers again.
  let signedOut = false;
  const handled = (error: unknown): boolean => {
    if (!(error instanceof StaleSession) && !opts.authFail?.(error)) return false;
    signedOut = true;
    return true;
  };
  function save(next: ChatSendDelay): void {
    const mine = ++picks;
    const ticket = ++newestSave;
    const current = sameSession();
    // A newer pick from any row (this one, or the one Chat rebuilt it as) says what he wants now; a pick from a
    // session that has since ended never goes under the next one.
    const replaced = () => ticket !== newestSave || !current();
    pending += 1;
    delay = next;
    paint();
    const same = (saved: ChatSendDelay) => saved.on === next.on && saved.seconds === next.seconds;
    // Only the newest pick shows its outcome: an older one's is already painted over.
    const failed = () => {
      if (mine !== picks) return;
      delay = confirmed;
      flash("Send delay didn't save. Try again.", "error");
    };
    const landed = (saved: ChatSendDelay) => {
      confirm(saved);
      if (mine !== picks) return;
      delay = saved;
      if (!same(saved)) flash("Send delay didn't save. Try again.", "error");
    };
    const revert = () => {
      if (mine === picks) delay = confirmed;
    };
    const run = (): Promise<void> => {
      // A pick already replaced by a newer one queued behind it never goes: the newer one says what he wants.
      if (mine !== picks || replaced()) return Promise.resolve();
      if (signedOut) {
        revert();
        return Promise.resolve();
      }
      // A save whose answer was lost (no answer, a timeout, a rate limit or a 5xx) may still have landed, so the server is
      // asked what it holds. It is never sent again: Settings › Behaviours may have saved a newer value since. A refusal
      // is final. Once a newer pick is waiting, a lost save is left as it is: the newer one goes next and its answer counts.
      return cmd.putChatSendDelay(next).then(landed, (error: unknown) => {
        if (handled(error)) return revert();
        if (replaced()) return revert();
        if (!cmd.lostAnswer(error)) return failed();
        return cmd.getChatSendDelay().then(landed, (readError: unknown) => (handled(readError) ? revert() : failed()));
      });
    };
    saveQueue = saveQueue
      .then(run)
      // Nothing that throws in one save ever stops the ones after it.
      .catch(() => undefined)
      .finally(() => {
        pending -= 1;
        paint();
      });
  }
  function refresh(): void {
    // A save on its way answers with the value itself; a read now could paint the one before it.
    if (pending) return;
    const mine = ++reads;
    const before = picks;
    unread = false;
    paint();
    // Saves an earlier row still has queued go first, so the read sees what they leave; a session that ended meanwhile
    // gets no read (its 401 would sign out the next one).
    const current = sameSession();
    saveQueue.then(() => (current() ? cmd.getChatSendDelay() : Promise.reject(new StaleSession()))).then(
      (saved) => {
        // Only the newest read counts, except that any answer beats none.
        if ((mine !== reads && known) || picks !== before || pending) return;
        signedOut = false;
        confirm(saved);
        delay = saved;
        paint();
      },
      (error: unknown) => {
        if (handled(error) || mine !== reads || known) return;
        // A row the server has never answered stays shut and says so.
        unread = true;
        paint();
      },
    );
  }
  paint();
  const el = h(
    "div",
    { class: "chat-delay", attrs: { role: "group", "aria-label": "Send delay" } },
    toggle,
    h("div", { class: "chat-size-row chat-delay-row" }, h("div", { class: "chat-size-choices" }, ...buttons), note),
  );
  return { el, refresh };
}
