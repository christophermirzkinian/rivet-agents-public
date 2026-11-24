import "./behaviours.css";
import "./connectors.css";
import "./ops.css";

import { CLAUDE_CODE, type ConnectorAccount, type ConnectorService, type SigninMode, type SigninService, type SigninStatus } from "../../../src/shared/connectors.js";
import { when } from "../../../src/shared/when.js";
import { ApiError, getSignin, sendSigninCode, startSignin } from "../api.js";
import { logoOf } from "../connector-logos.js";
import { h, svg } from "../dom.js";
import { loadConnectors, opsData, watchOps } from "../ops-data.js";
import { signedInByCode } from "../session.js";
import { enterScreen, leaveScreen } from "../usage.js";

// Connectors: every service the agents sign in to, grouped by whether it
// needs attention, and each one's accounts. A service the server offers sign-in for gets Connect, Reconnect and Add
// account; the sign-in itself runs on the site's own page, and the sheet shows only its address, a device code and how
// it stands.

export const CONNECTORS_ICON =
  '<svg viewBox="0 0 24 24"><path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0zM12 16.5v4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

/** Whose page signing in happens on, where the service is not named after its company. */
const COMPANY: Record<string, string> = {
  claude: "Anthropic",
  "anthropic-api": "Anthropic",
  chatgpt: "OpenAI",
  gemini: "Google",
  gdrive: "Google",
  "google-play": "Google",
  "app-store": "Apple",
  meta: "Meta",
};

let root: HTMLElement | null = null;
let stop: (() => void) | null = null;
let query = "";
let open: string | null = null;
let input: HTMLInputElement | null = null;
let list: HTMLElement | null = null;

const POLL_MS = 2_000;

/** The sign-in this sheet started: its last status, or the words it ended on before it had one. */
interface Run {
  service: string;
  /** What the panel says the sign-in is for: "Signing in to Account 2". */
  title: string;
  status: SigninStatus | null;
  word: string | null;
  codeSent: boolean;
  shown: string;
}
let run: Run | null = null;
let poll: number | null = null;
/** Claude's code field: one per sign-in, kept across repaints so typing in it survives a refresh. */
let codeInput: HTMLInputElement | null = null;
/** The open detail sheet; its sign-in panel stays in place while the rest repaints. */
let sheet: { id: string; upper: HTMLElement; panel: HTMLElement; lower: HTMLElement } | null = null;

export function mount(el: HTMLElement): void {
  unmount();
  root = el;
  stop = watchOps(paint);
  paint();
}

export function unmount(): void {
  stop?.();
  stop = null;
  if (open) leaveScreen("connectors.detail");
  open = null;
  query = "";
  input = list = root = null;
  endRun();
}

export function refresh(): Promise<void> {
  return loadConnectors();
}

function logo(service: ConnectorService, big = false): HTMLElement {
  const { slug, mono } = logoOf(service);
  const cls = `cn-logo${big ? " big" : ""}${slug ? "" : " mono"}`;
  return h("span", { class: cls, attrs: { "aria-hidden": "true", ...(slug ? { "data-logo": slug } : {}) } }, slug ? h("span", { class: "cn-mark" }) : mono);
}

/** A service's dot: red with an account signed out, amber while one is not being read, green when all are fine. */
function serviceTone(service: ConnectorService): string {
  if (service.state === "attention") return "bad";
  if (service.state === "not-connected") return "idle";
  return service.accounts.every((one) => one.state === "ok") ? "ok" : "warn";
}

const ACCOUNT_TONE: Record<ConnectorAccount["state"], string> = { ok: "ok", stale: "warn", "signed-out": "bad", "not-read": "idle" };

function accountLine(account: ConnectorAccount, now: number): string {
  const checked = account.checkedAt ? `checked ${when(account.checkedAt, now)}` : null;
  if (account.state === "ok") return ["Connected", account.inUse ? "in use" : null, checked].filter(Boolean).join(" · ");
  const since = account.since ? `last good ${when(account.since, now)}` : null;
  return [account.reason ?? (account.state === "signed-out" ? "Signed out" : "Not read"), since ?? checked].filter(Boolean).join(" · ");
}

const dot = (tone: string) => h("span", { class: `ops-dot t-${tone}`, attrs: { "aria-hidden": "true" } });
const stateLine = (tone: string, words: string) => h("p", { class: "cn-state" }, dot(tone), words);
const group = (name: string, rows: HTMLElement[]) => [h("h4", { class: "bhv-group" }, name), h("section", { class: "panel box bhv-list" }, ...rows)];

function serviceRow(service: ConnectorService): HTMLElement {
  return h(
    "button",
    {
      class: "cn-row",
      attrs: { type: "button", "data-key": service.id, "data-use": "connectors.service", "aria-label": `${service.name}, ${service.line}` },
      on: { click: () => show(service.id) },
    },
    logo(service),
    h("span", { class: "cn-text" }, h("span", { class: "cn-name" }, service.name), stateLine(serviceTone(service), service.line)),
    h("span", { class: "cn-chev", attrs: { "aria-hidden": "true" } }, "›"),
  );
}

function show(id: string | null): void {
  if (open) leaveScreen("connectors.detail");
  open = id;
  if (open) enterScreen("connectors.detail");
  input = list = null;
  sheet = null;
  if (run && run.service !== id) endRun();
  paint();
  root?.closest(".home-sheet-body, .sheet-body")?.scrollTo({ top: 0 });
}

function paintList(): void {
  if (!list) return;
  const body = opsData.connectors;
  if (!body) {
    const note = opsData.connectorsAbsent ? "Connectors are not set up on this copy." : opsData.connectorsFailed ? "Connectors did not load. Pull down to try again." : "Reading your connectors…";
    list.replaceChildren(h("p", { class: "cn-note" }, note));
    return;
  }
  const q = query.trim().toLowerCase();
  const shown = body.services.filter((one) => !q || one.name.toLowerCase().includes(q));
  if (!shown.length) {
    list.replaceChildren(h("p", { class: "cn-note" }, `No connector matches “${query.trim()}”.`));
    return;
  }
  const of = (state: ConnectorService["state"]) => shown.filter((one) => one.state === state).map(serviceRow);
  const attention = of("attention");
  const connected = of("connected");
  const off = of("not-connected");
  list.replaceChildren(
    ...(attention.length ? group(`Needs attention · ${attention.length}`, attention) : []),
    ...(connected.length ? group(`Connected · ${connected.length}`, connected) : []),
    ...(off.length ? group("Not connected", off) : []),
    ...(opsData.connectorsFailed ? [h("p", { class: "cn-note" }, "The last refresh failed: showing the one before.")] : []),
  );
}

const OPEN_STATES: readonly SigninStatus["state"][] = ["starting", "waiting"];
const runOpen = () => !!run && (run.status ? OPEN_STATES.includes(run.status.state) : run.word === null);

function endRun(): void {
  if (poll !== null) clearTimeout(poll);
  poll = null;
  run = null;
  codeInput = null;
}

function schedulePoll(): void {
  if (poll !== null) clearTimeout(poll);
  poll = window.setTimeout(() => {
    poll = null;
    const id = run?.status?.id;
    if (!id) return;
    const mine = run;
    getSignin(id).then(
      (status) => take(mine, status),
      (err: unknown) => {
        if (!run || run !== mine || run.status?.id !== id) return;
        if (err instanceof ApiError && err.status === 404) return take(mine, { ...run.status, state: "expired" });
        schedulePoll();
      },
    );
  }, POLL_MS);
}

/**
 * A status from the server for the sign-in `mine` asked about: dropped once the sheet has moved on to another sign-in.
 * The panel repaints only when what it shows changes, so the code field keeps its focus.
 */
function take(mine: Run | null, status: SigninStatus): void {
  if (!run || run !== mine || run.service !== status.service || (run.status && run.status.id !== status.id)) return;
  run.status = status;
  run.word = null;
  if (OPEN_STATES.includes(status.state)) schedulePoll();
  else {
    codeInput = null;
    void loadConnectors();
  }
  paint();
}

async function begin(service: ConnectorService, mode: SigninMode, account?: ConnectorAccount): Promise<void> {
  if (runOpen()) return;
  endRun();
  const title = mode === "add" ? `Adding a ${service.name} account` : account ? `Signing in to ${account.label}` : `Connecting ${service.name}`;
  const mine: Run = { service: service.id, title, status: null, word: null, codeSent: false, shown: "" };
  run = mine;
  paint();
  try {
    take(mine, await startSignin({ service: service.id as SigninService, mode, ...(account ? { account: account.id } : {}) }));
  } catch (err) {
    if (run !== mine) return;
    mine.word = err instanceof ApiError && err.status < 500 ? err.message : "The sign-in didn't start. Try again.";
    paint();
  }
}

async function sendCode(): Promise<void> {
  const mine = run;
  const id = run?.status?.id;
  const field = codeInput;
  if (!mine || !id || !field) return;
  const code = field.value.trim();
  if (!CLAUDE_CODE.test(code)) {
    field.setCustomValidity("That isn't the code from the page.");
    field.reportValidity();
    return;
  }
  field.value = "";
  mine.codeSent = true;
  try {
    take(mine, await sendSigninCode(id, code));
  } catch {
    if (run !== mine || mine.status?.id !== id) return;
    mine.codeSent = false;
    mine.word = "That code wasn't accepted. Check it and send it again.";
    paint();
  }
}

function signinWords(service: ConnectorService, status: SigninStatus | null): string {
  if (!status || status.state === "starting") return service.id === "gdrive" ? "Starting the sign-in…" : "Starting the sign-in on the Mac…";
  switch (status.state) {
    case "waiting":
      if (run?.codeSent) return "Code sent. Finishing the sign-in…";
      if (status.userCode) return "Open the page and type this code there.";
      if (status.needsCode) return "Open the page and sign in. Then paste the code it shows here.";
      return "Open the page and sign in there. This updates when it's done.";
    case "signed-in":
      return "Signed in.";
    case "failed":
      return "The sign-in didn't finish. Nothing changed.";
    case "expired":
      return "The sign-in ran out of time. Start it again.";
  }
}

function paintSignin(): void {
  if (!sheet) return;
  const service = opsData.connectors?.services.find((one) => one.id === sheet?.id);
  if (!service || !run || run.service !== service.id) {
    sheet.panel.replaceChildren();
    if (run) run.shown = "";
    return;
  }
  const status = run.status;
  const waiting = status?.state === "waiting";
  const shown = JSON.stringify([status?.state, status?.url, status?.userCode, status?.needsCode, run.word, run.codeSent]);
  if (shown === run.shown) return;
  run.shown = shown;
  const company = COMPANY[service.id] ?? service.name;
  const askCode = waiting && status.needsCode && !run.codeSent;
  if (askCode && !codeInput) {
    codeInput = h("input", {
      class: "cn-code-field",
      attrs: { id: "cn-code-field", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", maxlength: "244", pattern: CLAUDE_CODE.source.slice(1, -1), enterkeyhint: "send" },
      on: {
        input: () => codeInput?.setCustomValidity(""),
        keydown: (event) => {
          if ((event as KeyboardEvent).key === "Enter") void sendCode();
        },
      },
    }) as HTMLInputElement;
  }
  const done = run.word !== null || (status !== null && !OPEN_STATES.includes(status.state));
  sheet.panel.replaceChildren(
    h(
      "section",
      { class: "panel box cn-signin", attrs: { "aria-live": "polite" } },
      h("h4", { class: "cn-signin-title" }, run.title),
      h("p", { class: "cn-signin-words" }, run.word ?? signinWords(service, status)),
      ...(waiting && status.url && !run.codeSent
        ? [h("a", { class: "btn primary cn-signin-open", attrs: { href: status.url, target: "_blank", rel: "noopener noreferrer", "data-use": "connectors.signin-open" } }, `Open ${company}'s sign-in page`)]
        : []),
      ...(waiting && status.userCode ? [h("p", { class: "cn-signin-code", attrs: { "aria-label": `Code ${status.userCode.split("").join(" ")}` } }, status.userCode)] : []),
      ...(askCode && codeInput
        ? [
            h("label", { class: "cn-code-label", attrs: { for: "cn-code-field" } }, "Code from the page"),
            h("div", { class: "cn-signin-send" }, codeInput, h("button", { class: "btn primary", attrs: { type: "button", "data-use": "connectors.code-send" }, on: { click: () => void sendCode() } }, "Send code")),
          ]
        : []),
      ...(done
        ? [
            h(
              "button",
              {
                class: "btn",
                attrs: { type: "button", "data-use": "connectors.signin-done" },
                on: {
                  click: () => {
                    endRun();
                    paint();
                  },
                },
              },
              "Done",
            ),
          ]
        : []),
    ),
  );
  if (!askCode) codeInput = null;
}

/** The sign-ins the server offers, none of them in a window a device code signed in: the server refuses that session each. */
const offerOf = (service: ConnectorService): ConnectorService["signIn"] => (signedInByCode() === true ? undefined : service.signIn);

/**
 * Whether an account takes Reconnect: Drive's one always does, since its token can lapse while it still reads as fine;
 * a Mac service's only when it is signed out or not being read, and only with an id the server's Reconnect names it by.
 */
function reconnects(service: ConnectorService, account: ConnectorAccount): boolean {
  if (!offerOf(service)?.reconnect) return false;
  if (service.id === "gdrive") return true;
  if (account.state !== "signed-out" && account.state !== "stale") return false;
  if (service.id === "claude") return /^account-\d{1,2}$/.test(account.id);
  if (service.id === "chatgpt") return /^chatgpt-[0-9a-f]{12}$/.test(account.id);
  return true;
}

function signinButton(service: ConnectorService, mode: SigninMode, words: string, account?: ConnectorAccount): HTMLElement {
  const use = mode === "add" ? "connectors.add" : mode === "connect" ? "connectors.connect" : "connectors.reconnect";
  return h("button", { class: `btn${mode === "reconnect" ? "" : " primary"} cn-signin-btn`, attrs: { type: "button", "data-use": use, ...(runOpen() ? { disabled: "" } : {}) }, on: { click: () => void begin(service, mode, account) } }, words);
}

function paintDetail(service: ConnectorService): HTMLElement[] {
  const now = Date.now();
  const connected = service.accounts.filter((one) => one.state === "ok" || one.state === "stale").length;
  const count = service.accounts.length ? `${connected} of ${service.accounts.length} account${service.accounts.length === 1 ? "" : "s"} connected` : "No accounts connected";
  const company = COMPANY[service.id] ?? service.name;
  const offer = offerOf(service);
  const rows = service.accounts.map((one) =>
    h(
      "div",
      { class: "cn-row cn-account" },
      dot(ACCOUNT_TONE[one.state]),
      h("span", { class: "cn-text" }, h("span", { class: "cn-name" }, one.label), h("span", { class: "cn-state" }, accountLine(one, now))),
      ...(reconnects(service, one) ? [signinButton(service, "reconnect", "Reconnect", one)] : []),
    ),
  );
  const actions = [
    ...(offer?.connect && !service.accounts.length ? [signinButton(service, "connect", "Connect")] : []),
    ...(offer?.add && (service.accounts.length || !offer.connect) ? [signinButton(service, "add", "Add account")] : []),
  ];
  const how = actions.length || service.accounts.some((one) => reconnects(service, one)) ? undefined : service.how;
  const note = offer
    ? `Signing in happens on ${company}'s own page. This app sees only each account's status: never a key, password or email.`
    : service.signIn
      ? "Connect or add an account from a phone or computer signed in with a passkey. This page shows only each account's status: never a key, password or email."
      : "This page shows only each account's status: never a key, password or email.";
  return [
    h("button", { class: "cn-back", attrs: { type: "button", "data-use": "connectors.back" }, on: { click: () => show(null) } }, h("span", { class: "cn-back-mark", attrs: { "aria-hidden": "true" } }, "‹"), "All services"),
    h("div", { class: "cn-head" }, logo(service, true), h("div", { class: "cn-text" }, h("h3", { class: "cn-name" }, service.name), stateLine(serviceTone(service), count))),
    ...(actions.length ? [h("div", { class: "cn-actions" }, ...actions)] : []),
    ...(rows.length ? group("Accounts", rows) : []),
    h("section", { class: "panel box" }, ...(how ? [h("p", { class: "cn-note cn-how" }, how)] : []), h("p", { class: "cn-note" }, note)),
  ];
}

function paint(): void {
  if (!root) return;
  const service = open ? opsData.connectors?.services.find((one) => one.id === open) : null;
  if (open && service) {
    const [back, head, ...rest] = paintDetail(service);
    if (!sheet || sheet.id !== service.id || !root.contains(sheet.panel)) {
      sheet = { id: service.id, upper: h("div", { class: "cn-part" }), panel: h("div", { class: "cn-part" }), lower: h("div", { class: "cn-part" }) };
      root.replaceChildren(h("div", { class: "cn cn-detail" }, sheet.upper, sheet.panel, sheet.lower));
      if (run) run.shown = "";
    }
    sheet.upper.replaceChildren(back!, head!);
    sheet.lower.replaceChildren(...rest);
    paintSignin();
    return;
  }
  if (open && !service && opsData.connectors) return show(null);
  if (!input || !list) {
    input = h("input", {
      class: "cn-q",
      attrs: { type: "search", placeholder: "Search connections", autocomplete: "off", enterkeyhint: "search", "aria-label": "Search connectors", "data-use": "connectors.search" },
      on: {
        input: () => {
          query = input?.value ?? "";
          paintList();
        },
      },
    }) as HTMLInputElement;
    input.value = query;
    list = h("div", { class: "cn-groups" });
    root.replaceChildren(h("div", { class: "cn" }, h("label", { class: "cn-search" }, svg(SEARCH_ICON, "cn-search-icon"), input), list));
  }
  paintList();
}
