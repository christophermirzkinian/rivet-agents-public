import { agentName, readMindSetup, saveMindSetup } from "../cloud-agent.js";
import { button, h } from "../dom.js";
import { onSessionReset } from "../session.js";

// The Mind page on a hosted machine with no map: five questions with Back, a true-or-false list with neither chosen to
// start, then what the agent knows. The words come from the machine's supervisor; a tap sends ids only.

export interface MindSetup {
  questions: { id: string; title: string; options: { id: string; title: string; note: string }[] }[];
  list: { title: string; lines: { id: string; say: string }[] }[];
  answers: Map<string, string>;
  said: Map<string, boolean>;
  /** What the machine last said it holds: a save that fails puts this back, never an earlier tap that also failed. */
  held: Map<string, string | boolean>;
  /** The kept block was edited by hand so its lines can't be told apart: shown, never changed. */
  locked: boolean;
}

const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((one): one is Record<string, unknown> => !!one && typeof one === "object") : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(text) : []);

/** Null for anything but the whole answer: an older supervisor's page keeps the plain words. */
export function parseMindSetup(body: unknown): MindSetup | null {
  if (!body || typeof body !== "object") return null;
  const { questions, list, state } = body as Record<string, unknown>;
  if (!state || typeof state !== "object") return null;
  const { kind, answers, yes, no } = state as Record<string, unknown>;
  const asked = arr(questions).flatMap(({ id, title, options }) => {
    const choices = arr(options).flatMap((o) => (text(o.id) && text(o.title) ? [{ id: o.id, title: o.title, note: text(o.note) ? o.note : "" }] : []));
    return text(id) && text(title) && choices.length ? [{ id, title, options: choices }] : [];
  });
  const groups = arr(list).flatMap(({ title, lines }) => {
    const rows = arr(lines).flatMap((l) => (text(l.id) && text(l.say) ? [{ id: l.id, say: l.say }] : []));
    return text(title) && rows.length ? [{ title, lines: rows }] : [];
  });
  if (!asked.length || !groups.length) return null;
  const given = answers && typeof answers === "object" ? Object.entries(answers as Record<string, unknown>).filter((one): one is [string, string] => text(one[1])) : [];
  const said = [...strings(yes).map((id) => [id, true] as const), ...strings(no).map((id) => [id, false] as const)];
  return {
    questions: asked,
    list: groups,
    answers: new Map(given),
    said: new Map(said),
    held: new Map<string, string | boolean>([...given, ...said]),
    locked: kind === "damaged" || kind === "doubled",
  };
}

type Step = { at: "question"; n: number; one?: boolean } | { at: "list"; one?: boolean } | { at: "knows" };

let data: MindSetup | null = null;
/** "none": not a hosted machine's, or one whose supervisor has no such page. */
let reading: "unread" | "busy" | "none" | "failed" | "ready" = "unread";
let step: Step = { at: "knows" };
let note = "";
/** Taps are saved one at a time, in the order they were made. */
let saving: Promise<void> = Promise.resolve();
let unsaved = 0;
let taps = 0;
/** Each id's newest tap: only that one's failure changes what is shown. */
const newest = new Map<string, number>();
let epoch = 0;

onSessionReset(() => {
  epoch++;
  unsaved = 0;
  newest.clear();
  data = null;
  reading = "unread";
  step = { at: "knows" };
  note = "";
  saving = Promise.resolve();
});

const fresh = (d: MindSetup) => !d.answers.size && !d.said.size;

/** Where the page opens: the first question until something has been answered, then what the agent knows. */
export function openMindSetup(): void {
  note = "";
  if (data) step = fresh(data) && !data.locked ? { at: "question", n: 0 } : { at: "knows" };
}

export const mindSetupReading = () => reading;

export async function loadMindSetup(): Promise<void> {
  if (reading === "busy") return;
  const mine = epoch;
  const had = data !== null;
  const tapped = taps;
  reading = had ? "ready" : "busy";
  await saving;
  const read = await readMindSetup();
  if (mine !== epoch || tapped !== taps) return; // A tap made meanwhile is newer than this answer.
  const got = "body" in read ? parseMindSetup(read.body) : null;
  if (got) {
    data = got;
    if (step.at === "question" && !got.questions[step.n]) step = { at: "knows" };
    reading = "ready";
    if (!had) openMindSetup();
  } else if (!had) reading = "absent" in read && !read.absent ? "failed" : "none";
}

const say = (title: string) => title.replaceAll("{agent}", agentName());

/** The setup's screen in `el`, redrawn in place at every tap. */
export function paintMindSetup(el: HTMLElement): void {
  const d = data;
  if (!d) return;
  let drawn: HTMLElement | null = null;
  const draw = (focus = false) => {
    if (!el.isConnected || (drawn && drawn.parentElement !== el)) return; // Something else, such as the map, is there now.
    const body = step.at === "question" ? question(d, step, go) : step.at === "list" ? trueFalse(d, step, go, tap) : knows(d, go, tap);
    const line = note ? h("p", { class: "ms-note", attrs: { role: "status" } }, note) : null;
    const was = focus ? null : (document.activeElement as HTMLElement | null)?.dataset?.msKey;
    drawn = h("div", { class: `mind-setup ms-${step.at}` }, ...body, line);
    el.replaceChildren(drawn);
    if (was) el.querySelector<HTMLElement>(`[data-ms-key="${CSS.escape(was)}"]`)?.focus({ preventScroll: true });
    if (focus) {
      el.querySelector<HTMLElement>(".ms-title")?.focus({ preventScroll: true });
      el.closest(".home-sheet-body, .sheet-body")?.scrollTo?.(0, 0);
    }
  };
  const go: Go = (to) => {
    step = to;
    note = "";
    draw(true);
  };
  const tap: Tap = (id, value) => {
    save(d, id, value);
    draw();
  };
  onDraw = () => draw();
  onSaved = () => drawn?.querySelector(".ms-saving")?.replaceChildren();
  draw();
}

let onDraw: () => void = () => {};
/** Clears the words in place: a redraw here could take a button from under a finger. */
let onSaved: () => void = () => {};

type Go = (to: Step) => void;
type Tap = (id: string, value: string | boolean | null) => void;

function put(d: MindSetup, id: string, value: string | boolean | null): void {
  if (typeof value === "string") d.answers.set(id, value);
  else if (typeof value === "boolean") d.said.set(id, value);
  else {
    d.answers.delete(id);
    d.said.delete(id);
  }
}

const words: Record<string, string> = {
  theirs: "You have your own skill with that name, so nothing was changed.",
  damaged: "This part of your CLAUDE.md was edited by hand, so nothing was changed.",
  doubled: "This part of your CLAUDE.md was edited by hand, so nothing was changed.",
};

/** Shown at once; a save that didn't land puts back what the machine holds, unless a later tap has changed it again. */
function save(d: MindSetup, id: string, value: string | boolean | null): void {
  const mine = epoch;
  const tap = ++taps;
  newest.set(id, tap);
  unsaved++;
  put(d, id, value);
  note = "";
  saving = saving.then(async () => {
    if (mine !== epoch) return;
    const result = await saveMindSetup(id, value === null ? "" : String(value));
    if (mine !== epoch) return;
    if (!--unsaved) onSaved();
    if (result === "set" || result === "kept") {
      if (value === null) d.held.delete(id);
      else d.held.set(id, value);
      return;
    }
    if (newest.get(id) === tap) put(d, id, d.held.get(id) ?? null);
    note = words[result ?? ""] ?? "That didn't save. Try again.";
    onDraw();
  });
}

const nav = (back: (() => void) | null, middle: string, skip: (() => void) | null) =>
  h(
    "div",
    { class: "ms-nav" },
    back ? button("Back", back, "ms-back", false, "mind.back") : h("span"),
    h("span", { class: "ms-count" }, middle),
    skip ? button("Skip", skip, "ms-skip", false, "mind.skip") : h("span"),
  );

const title = (words: string) => h("h3", { class: "ms-title", attrs: { tabindex: "-1" } }, words);

function keyed(el: HTMLButtonElement, key: string): HTMLButtonElement {
  el.dataset.msKey = key;
  return el;
}

function question(d: MindSetup, at: { n: number; one?: boolean }, go: Go): HTMLElement[] {
  const q = d.questions[at.n]!;
  const next: Step = at.one ? { at: "knows" } : at.n + 1 < d.questions.length ? { at: "question", n: at.n + 1 } : { at: "list" };
  const back: Step | null = at.one ? { at: "knows" } : at.n ? { at: "question", n: at.n - 1 } : null;
  const options = q.options.map((o) => {
    const on = d.answers.get(q.id) === o.id;
    const el = keyed(
      button([h("b", {}, o.title), o.note ? h("small", {}, o.note) : null], () => {
        save(d, q.id, o.id); // Also when it shows as chosen: another tab may have changed it since.
        go(next);
      }, `ms-option${on ? " is-on" : ""}`, false, "mind.answer"),
      `${q.id}:${o.id}`,
    );
    el.setAttribute("aria-pressed", String(on));
    return el;
  });
  const remove = () =>
    button("Remove my answer", () => {
      save(d, q.id, null);
      go({ at: "knows" });
    }, "ms-link", false, "mind.remove");
  return [
    nav(back && (() => go(back)), at.one ? "" : `${at.n + 1} of ${d.questions.length}`, at.one ? null : () => go(next)),
    title(say(q.title)),
    h("div", { class: "ms-options", attrs: { role: "group", "aria-label": say(q.title) } }, ...options),
    ...(at.one ? (d.answers.has(q.id) ? [h("div", { class: "ms-space" }), remove()] : []) : [h("div", { class: "ms-space" }), button("Skip all", () => go({ at: "knows" }), "ms-link", false, "mind.skip-all")]),
  ];
}

function trueFalse(d: MindSetup, at: { one?: boolean }, go: Go, tap: Tap): HTMLElement[] {
  const pick = (id: string, about: string, value: boolean) => {
    const on = d.said.get(id) === value;
    const el = keyed(button(value ? "True" : "False", () => tap(id, value),`ms-pick ${value ? "is-true" : "is-false"}${on ? " is-on" : ""}`, false, value ? "mind.true" : "mind.false"), `${id}:${value}`);
    el.setAttribute("aria-pressed", String(on));
    el.setAttribute("aria-label", `${value ? "True" : "False"}: ${about}`);
    return el;
  };
  return [
    nav(() => go(at.one ? { at: "knows" } : { at: "question", n: d.questions.length - 1 }), "", at.one ? null : () => go({ at: "knows" })),
    title("True or false?"),
    h("p", { class: "ms-lead" }, "Nothing is on until you tap True."),
    ...d.list.map((group) =>
      h(
        "section",
        { class: "ms-group" },
        h("h4", {}, group.title),
        ...group.lines.map((line) => h("div", { class: "ms-row" }, h("span", {}, line.say), h("div", { class: "ms-picks" }, pick(line.id, line.say, true), pick(line.id, line.say, false)))),
      ),
    ),
    h("div", { class: "ms-foot" }, button("Done", () => go({ at: "knows" }), "primary ms-done", false, "mind.done")),
  ];
}

function knows(d: MindSetup, go: Go, tap: Tap): HTMLElement[] {
  const name = agentName();
  if (d.locked)
    return [title(`What ${name} knows`), h("p", { class: "ms-lead" }, "The part of your CLAUDE.md this page keeps was edited by hand, so it can't be changed here. Fix or remove that part and it comes back.")];
  const savingLine = h("p", { class: "ms-lead ms-saving", attrs: { role: "status" } }, unsaved ? "Saving your answers. Keep this page open." : null);
  if (fresh(d))
    return [
      title(`${name} doesn't know how you like things done yet`),
      savingLine,
      h("p", { class: "ms-lead" }, "Five quick questions, one tap each. You can change or remove anything later."),
      h("div", { class: "ms-foot" }, button("Answer 5 questions", () => go({ at: "question", n: 0 }), "primary ms-done", false, "mind.start")),
    ];
  const answers = d.questions.map((q, n) => {
    const chosen = q.options.find((o) => o.id === d.answers.get(q.id));
    const change = button(chosen ? "Change" : "Answer", () => go({ at: "question", n, one: true }), "ms-small", false, "mind.change");
    change.setAttribute("aria-label", `${chosen ? "Change" : "Answer"}: ${say(q.title)}`);
    return h("div", { class: "ms-row" }, h("span", {}, h("small", {}, say(q.title)), chosen?.title ?? "Not answered"), change);
  });
  const on = d.list.flatMap((group) => group.lines).filter((line) => d.said.get(line.id) === true);
  return [
    title(`What ${name} knows`),
    savingLine,
    h("section", { class: "ms-group" }, h("h4", {}, "Your answers"), ...answers),
    h(
      "section",
      { class: "ms-group" },
      h("h4", {}, "Switched on"),
      ...on.map((line) => {
        const off = button("Remove", () => tap(line.id, null), "ms-small", false, "mind.remove");
        off.setAttribute("aria-label", `Remove: ${line.say}`);
        return h("div", { class: "ms-row" }, h("span", {}, line.say), off);
      }),
      on.length ? null : h("p", { class: "ms-lead" }, "Nothing yet."),
    ),
    h("div", { class: "ms-foot" }, button("Open the list", () => go({ at: "list", one: true }), "ms-done", false, "mind.open-list")),
  ];
}
