import "./what-you-used.css";

import {
  reworkWords,
  USAGE_AREAS,
  USAGE_WINDOW_DAYS,
  type UsageArea,
  type UsageAsk,
  type UsageDevice,
  type UsageFeature,
  type UsageReport,
  type UsageStatus,
} from "../../../src/shared/usage-ids.js";
import { shortDate } from "../../../src/shared/when.js";
import { ApiError, askUsage, getUsageReport } from "../api.js";
import { describe, h } from "../dom.js";

// More › What you used: what you tapped and opened in the last 30 days, phone first, counted by the server when the
// page asks. Retire? and Rework? only send a card; nothing is removed from here. Every feature sits in its area's fold,
// closed until opened.

const DEVICES: { device: UsageDevice; name: string }[] = [
  { device: "phone", name: "Phone" },
  { device: "desktop", name: "Computer" },
];
const DEVICE_WORDS: Record<UsageDevice, string> = { phone: "your phone", desktop: "your computer" };

let root: HTMLElement | null = null;
let device: UsageDevice = "phone";
let report: UsageReport | null = null;
let failed: string | null = null;
/** The folds open by hand, kept across a device switch; and, while a search is on, the ones open in its results. */
let open = new Set<UsageArea>();
let query = "";
let searchOpen = new Set<UsageArea>();
let foldsEl: HTMLElement | null = null;
let toggleEl: HTMLButtonElement | null = null;
let pending: string | null = null;
let note: { id: string; text: string; tone: "yes" | "no" } | null = null;

export function mount(el: HTMLElement): void {
  unmount();
  root = el;
  device = "phone";
  open = new Set();
  query = "";
  searchOpen = new Set();
  paint();
  void refresh();
}

export function unmount(): void {
  root = null;
  foldsEl = null;
  toggleEl = null;
  report = null;
  failed = null;
  pending = null;
  note = null;
}

export async function refresh(): Promise<void> {
  const asked = device;
  try {
    const read = await getUsageReport(asked);
    if (asked !== device) return;
    report = read;
    failed = null;
  } catch (err) {
    if (asked !== device) return;
    failed = describe(err);
  }
  paint();
}

function pick(next: UsageDevice): void {
  if (next === device) return;
  device = next;
  report = null;
  failed = null;
  note = null;
  paint();
  void refresh();
}

async function ask(row: UsageFeature, what: UsageAsk): Promise<void> {
  if (pending) return;
  pending = row.id;
  note = null;
  paint();
  try {
    await askUsage(row.id, what, device);
    note = { id: row.id, text: "Sent to Cards. Nothing changes until you answer it.", tone: "yes" };
  } catch (err) {
    const coded = err instanceof ApiError && err.status >= 400 && err.status !== 401 && err.status !== 403;
    note = { id: row.id, text: coded ? `Not sent: ${err.message}.` : describe(err), tone: "no" };
  } finally {
    pending = null;
  }
  await refresh();
}

const plural = (n: number, one: string) => `${n.toLocaleString("en-AU")} ${one}${n === 1 ? "" : "s"}`;

function summary(read: UsageReport): HTMLElement {
  const on = DEVICE_WORDS[read.device];
  if (!read.since) return h("p", { class: "used-sum" }, "Nothing recorded yet. Taps are counted from the next time you open the app.");
  const counted = [h("b", {}, plural(read.taps, "tap")), " and ", h("b", {}, plural(read.opened, "screen")), " opened on ", h("b", {}, plural(read.daysUsed, "day"))];
  if (read.recorded < USAGE_WINDOW_DAYS) return h("p", { class: "used-sum" }, `Recording since ${shortDate(read.since)} · on ${on}, `, ...counted);
  return h("p", { class: "used-sum" }, `Last ${USAGE_WINDOW_DAYS} days on ${on} · `, ...counted);
}

/** The status words, in the order an area's header splits them. */
const STATUS_WORDS: Record<Exclude<UsageStatus, "removed">, string> = { lot: "a lot", some: "sometimes", untouched: "untouched", unclear: "can't tell" };
const STATUS_ORDER = Object.keys(STATUS_WORDS) as Exclude<UsageStatus, "removed">[];

function statusChip(row: UsageFeature): HTMLElement {
  const words = row.status === "removed" ? `Removed ${shortDate(row.removed ?? "")}` : STATUS_WORDS[row.status];
  return h("span", { class: `used-status ${row.status}` }, words);
}

function chip(row: UsageFeature, what: UsageAsk): HTMLElement {
  if (row.asked) return h("span", { class: "used-asked" }, row.asked === "kept" ? "Kept" : "Asked");
  return h(
    "button",
    {
      class: `used-chip ${what}`,
      attrs: { type: "button", "data-use": `used.${what}`, "aria-label": `${what === "retire" ? "Retire" : "Rework"} ${row.label}?`, ...(pending ? { disabled: "" } : {}) },
      on: { click: () => void ask(row, what) },
    },
    pending === row.id ? "Sending…" : what === "retire" ? "Retire?" : "Rework?",
  );
}

/** Retire? when it is in never used, Rework? when its numbers say so, or the card already asked. */
function action(row: UsageFeature): HTMLElement | null {
  if (row.rework) return chip(row, "rework");
  if (row.retire) return chip(row, "retire");
  return row.asked ? chip(row, "retire") : null;
}

/** Each number with its word, kept on one line (no-break spaces), so a narrow phone wraps only between them. */
function numbers(row: UsageFeature): string {
  const parts = [`Phone ${row.phone.toLocaleString("en-AU")}`, `Computer ${row.desktop.toLocaleString("en-AU")}`];
  if (row.days) parts.push(plural(row.days, "day"));
  if (row.last) parts.push(`last ${shortDate(row.last)}`);
  return parts.map((part) => part.replace(/ /g, "\u00a0")).join("\u00a0· ");
}

function line(row: UsageFeature): HTMLElement[] {
  const shown = [
    h(
      "div",
      { class: "used-row", attrs: { "data-id": row.id } },
      h(
        "div",
        { class: "used-words" },
        h("span", { class: "used-name" }, row.label),
        h("span", { class: "used-id" }, row.id),
        h("span", { class: "used-where" }, row.rework ? `${numbers(row)}\u00a0· ${reworkWords(row.rework)}` : numbers(row)),
      ),
      h("div", { class: "used-ends" }, statusChip(row), action(row)),
    ),
  ];
  if (note?.id === row.id) shown.push(h("p", { class: `used-note ${note.tone}`, attrs: { role: "status" } }, note.text));
  return shown;
}

const empty = (text: string) => h("p", { class: "used-empty" }, text);

function matches(row: UsageFeature, words: string): boolean {
  return row.label.toLowerCase().includes(words) || row.id.toLowerCase().includes(words);
}

/** Each area with rows, in USAGE_AREAS order, its rows used most first; only rows the search finds while it is on. */
function areas(read: UsageReport): { area: UsageArea; rows: UsageFeature[]; all: UsageFeature[] }[] {
  const words = query.trim().toLowerCase();
  return USAGE_AREAS.flatMap((area) => {
    const all = read.features.filter((row) => row.area === area);
    const rows = (words ? all.filter((row) => matches(row, words)) : all).sort((a, b) => b.phone + b.desktop - (a.phone + a.desktop));
    return rows.length ? [{ area, rows, all }] : [];
  });
}

const openSet = () => (query.trim() ? searchOpen : open);

function setOpen(area: UsageArea, on: boolean): void {
  const set = openSet();
  if (on) set.add(area);
  else set.delete(area);
}

function header(area: UsageArea, rows: UsageFeature[], isOpen: boolean, index: number): HTMLElement {
  const counts =
    area === "Removed"
      ? [h("span", { class: "used-status removed" }, `${rows.length} removed`)]
      : STATUS_ORDER.flatMap((status) => {
          const n = rows.filter((row) => row.status === status).length;
          return n ? [h("span", { class: `used-status ${status}` }, `${n} ${STATUS_WORDS[status]}`)] : [];
        });
  const id = `used-fold-${index}`;
  return h(
    "button",
    {
      class: "used-fold-head",
      // aria-controls only while its rows are in the page: a closed fold has none to point at.
      attrs: { type: "button", "data-use": "used.fold", "data-use-value": String(index + 1), "aria-expanded": String(isOpen), ...(isOpen ? { "aria-controls": id } : {}) },
      on: {
        click: () => {
          setOpen(area, !isOpen);
          paintFolds();
          // The repaint replaces this button, so focus goes to the new one: Enter again closes what it opened.
          const section = [...(foldsEl?.querySelectorAll<HTMLElement>(".used-fold") ?? [])].find((one) => one.dataset.area === area);
          section?.querySelector<HTMLButtonElement>(".used-fold-head")?.focus();
        },
      },
    },
    h("span", { class: "used-fold-title" }, h("span", { class: "used-fold-name" }, area), h("span", { class: "used-fold-n" }, rows.length.toLocaleString("en-AU")), h("span", { class: "used-fold-mark", attrs: { "aria-hidden": "true" } }, isOpen ? "−" : "+")),
    h("span", { class: "used-split" }, ...counts),
  );
}

function folds(read: UsageReport): HTMLElement[] {
  const shown = areas(read);
  const set = openSet();
  if (toggleEl) {
    const all = shown.length > 0 && shown.every(({ area }) => set.has(area));
    toggleEl.textContent = all ? "Collapse all" : "Expand all";
    toggleEl.setAttribute("aria-pressed", String(all));
  }
  if (!shown.length) return [empty(`No feature matches “${query.trim()}”.`)];
  return shown.map(({ area, rows }) => {
    const index = USAGE_AREAS.indexOf(area);
    const isOpen = set.has(area);
    return h(
      "section",
      { class: isOpen ? "used-fold is-open" : "used-fold", attrs: { "aria-label": area, "data-area": area } },
      header(area, rows, isOpen, index),
      isOpen ? h("div", { class: "used-rows", attrs: { id: `used-fold-${index}` } }, ...rows.flatMap((row) => line(row))) : null,
    );
  });
}

/** Repaints the folds alone, so the search box keeps its focus and caret as it types. */
function paintFolds(): void {
  if (!foldsEl || !report) return;
  foldsEl.replaceChildren(...folds(report));
}

function search(): void {
  if (!report) return;
  const words = query.trim().toLowerCase();
  searchOpen = new Set(words ? areas(report).map(({ area }) => area) : []);
  paintFolds();
}

function toolbar(): HTMLElement {
  const input = h("input", {
    class: "used-search",
    attrs: { type: "search", "aria-label": "Search features", placeholder: "Search features", autocomplete: "off", enterkeyhint: "search", "data-use": "used.search" },
    on: {
      input: (event) => {
        query = (event.target as HTMLInputElement).value;
        search();
      },
    },
  });
  input.value = query;
  toggleEl = h(
    "button",
    {
      class: "used-toggle",
      attrs: { type: "button", "data-use": "used.expand-all" },
      on: {
        click: () => {
          if (!report) return;
          const shown = areas(report).map(({ area }) => area);
          const set = openSet();
          const all = shown.every((area) => set.has(area));
          for (const area of shown) setOpen(area, !all);
          paintFolds();
        },
      },
    },
    "Expand all",
  );
  return h("div", { class: "used-tools" }, input, toggleEl);
}

function paint(): void {
  if (!root) return;
  const switcher = h(
    "div",
    { class: "used-devices", attrs: { role: "group", "aria-label": "Device" } },
    ...DEVICES.map(({ device: one, name }) =>
      h(
        "button",
        {
          class: one === device ? "used-device is-on" : "used-device",
          attrs: { type: "button", "data-use": `used.device.${one}`, "aria-pressed": String(one === device) },
          on: { click: () => pick(one) },
        },
        name,
      ),
    ),
  );
  foldsEl = null;
  toggleEl = null;
  let body: HTMLElement[];
  if (report?.since) {
    const tools = toolbar();
    foldsEl = h("div", { class: "used-folds" }, ...folds(report));
    body = [summary(report), tools, foldsEl];
  } else if (report) body = [summary(report)];
  else body = [h("p", { class: failed ? "used-sum is-warn" : "used-sum", attrs: { role: "status" } }, failed ?? "Counting…")];
  const focused = document.activeElement?.classList.contains("used-search") ?? false;
  root.replaceChildren(h("div", { class: "used" }, switcher, ...body, h("p", { class: "used-foot" }, "Each Retire? comes to you as a card first. Nothing is removed by itself.")));
  if (focused) root.querySelector<HTMLInputElement>(".used-search")?.focus();
}
