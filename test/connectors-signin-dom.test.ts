// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serviceOf, type ConnectorAccount, type ConnectorsResponse, type SigninStatus } from "../src/shared/connectors.js";
import { opsData, resetOps } from "../web/src/ops-data.js";
import * as connectorsPage from "../web/src/views/connectors.js";

// The Connectors sheet's sign-in panel: which accounts take Reconnect, what the panel says it is for, the code field's
// label, and a late answer for a sign-in the sheet has left never landing on the next one.

const AT = "2026-11-22T00:00:00.000Z";
const URL_A = "https://claude.com/cai/oauth/authorize?state=a";
const CODE = `AuthCodeFromThePage_0123456789-abcdef#${"S".repeat(43)}`;
const account = (id: string, label: string, state: ConnectorAccount["state"]): ConnectorAccount => ({ id, label, state, checkedAt: AT, since: null });
const body: ConnectorsResponse = {
  at: AT,
  services: [
    { ...serviceOf("claude", "Claude", [account("account-1", "Account 1", "ok"), account("account-2", "Account 2", "signed-out"), account("claude-3", "Account 3", "signed-out")]), signIn: { connect: true, reconnect: true, add: true } },
    { ...serviceOf("gdrive", "Drive", [account("gdrive-1", "Drive", "ok")]), signIn: { connect: true, reconnect: true, add: false } },
    { ...serviceOf("chatgpt", "ChatGPT", [account("chatgpt-0123456789ab", "ChatGPT 1", "stale"), account("codex-2", "ChatGPT 2", "stale")]), signIn: { connect: false, reconnect: true, add: true }, how: "Signed in on the Mac with OpenAI's Codex app." },
    { ...serviceOf("github", "GitHub", [account("github-1", "Main account", "signed-out")]), how: "Signed in on the Mac with GitHub's own app." },
    { ...serviceOf("fly", "Fly.io", [account("fly-1", "Main account", "signed-out")]), how: "Signed in on the Mac with Fly's own app." },
  ],
};
const status = (id: string, over: Partial<SigninStatus> = {}): SigninStatus => ({ id: id.repeat(43), service: "claude", state: "starting", expiresAt: "2026-11-22T00:10:00.000Z", ...over });

interface Ask {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  answer: (value: unknown, code?: number) => void;
}
let asks: Ask[];
let page: HTMLElement;
const realFetch = globalThis.fetch;

beforeEach(() => {
  asks = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith("/api/connectors/signin")) {
      return new Promise<Response>((resolve) => {
        asks.push({
          method: init?.method ?? "GET",
          path,
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
          answer: (value, code = 200) => resolve(new Response(JSON.stringify(value), { status: code, headers: { "content-type": "application/json" } })),
        });
      });
    }
    if (path === "/api/connectors") return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  opsData.at = Date.now();
  opsData.connectors = body;
  page = document.createElement("div");
  document.body.append(page);
  connectorsPage.mount(page);
});

afterEach(() => {
  connectorsPage.unmount();
  document.body.replaceChildren();
  globalThis.fetch = realFetch;
  resetOps();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const click = (selector: string) => page.querySelector<HTMLElement>(selector)!.click();
const openService = (id: string) => click(`.cn-row[data-key="${id}"]`);
const panel = () => page.querySelector<HTMLElement>(".cn-signin");
const words = () => panel()?.querySelector(".cn-signin-words")?.textContent;
const reconnectRows = () =>
  [...page.querySelectorAll<HTMLElement>(".cn-account")].filter((row) => row.querySelector('[data-use="connectors.reconnect"]')).map((row) => row.querySelector(".cn-name")?.textContent);
const last = () => asks[asks.length - 1]!;

describe("the Connectors sign-in panel", () => {
  it("offers Reconnect on Drive's account while it reads as fine, and names the account it signs in to", async () => {
    openService("gdrive");
    expect(reconnectRows()).toEqual(["Drive"]);
    click('[data-use="connectors.reconnect"]');
    expect(panel()?.querySelector(".cn-signin-title")?.textContent).toBe("Signing in to Drive");
    expect(words()).toBe("Starting the sign-in…");
    expect(last().body).toEqual({ service: "gdrive", mode: "reconnect", account: "gdrive-1" });
    last().answer(status("a", { service: "gdrive" }));
    await settle();
    expect(words()).toBe("Starting the sign-in…");
  });

  it("offers Reconnect only on a signed-out Claude account the server can name, and says which one it signs in to", async () => {
    openService("claude");
    expect(reconnectRows()).toEqual(["Account 2"]);
    click('[data-use="connectors.reconnect"]');
    expect(panel()?.querySelector(".cn-signin-title")?.textContent).toBe("Signing in to Account 2");
    expect(words()).toBe("Starting the sign-in on the Mac…");
    expect(last().body).toEqual({ service: "claude", mode: "reconnect", account: "account-2" });
  });

  it("offers Reconnect on a ChatGPT account only by its home's slot", async () => {
    openService("chatgpt");
    expect(reconnectRows()).toEqual(["ChatGPT 1"]);
    click('[data-use="connectors.reconnect"]');
    expect(last().body).toEqual({ service: "chatgpt", mode: "reconnect", account: "chatgpt-0123456789ab" });
  });

  it("offers Add account on ChatGPT beside Reconnect, naming no account", async () => {
    openService("chatgpt");
    expect(page.querySelector('[data-use="connectors.add"]')?.textContent).toBe("Add account");
    expect(page.querySelector(".cn-how")).toBeNull();
    expect(page.querySelector(".cn-note")?.textContent).toBe("Signing in happens on OpenAI's own page. This app sees only each account's status: never a key, password or email.");
    click('[data-use="connectors.add"]');
    expect(last().body).toEqual({ service: "chatgpt", mode: "add" });
    expect(panel()?.querySelector(".cn-signin-title")?.textContent).toBe("Adding a ChatGPT account");
  });

  it("offers no sign-in on Fly, which is status only, and says how it is connected", async () => {
    openService("fly");
    expect(page.querySelector(".cn-account")).not.toBeNull();
    expect(page.querySelector('[data-use="connectors.reconnect"], [data-use="connectors.connect"], [data-use="connectors.add"]')).toBeNull();
    expect([...page.querySelectorAll(".cn-note")].map((one) => one.textContent)).toEqual(["Signed in on the Mac with Fly's own app.", "This page shows only each account's status: never a key, password or email."]);
  });

  it("shows ChatGPT's how line when its four accounts are fine and the server offers no Add, so the sheet has no button", async () => {
    const was = body.services;
    body.services = was.map((one) =>
      one.id === "chatgpt" ? { ...one, accounts: ["0", "1", "2", "3"].map((n) => account(`chatgpt-${n.repeat(12)}`, `ChatGPT ${n}`, "ok")), signIn: { connect: false, reconnect: true, add: false } } : one,
    );
    try {
      connectorsPage.unmount();
      page.replaceChildren();
      connectorsPage.mount(page);
      openService("chatgpt");
      expect(page.querySelector('[data-use="connectors.reconnect"], [data-use="connectors.connect"], [data-use="connectors.add"]')).toBeNull();
      expect(page.querySelector(".cn-how")?.textContent).toBe("Signed in on the Mac with OpenAI's Codex app.");
    } finally {
      body.services = was;
    }
  });

  it("shows a sign-in service's how line, and no button, while the server offers it none", async () => {
    openService("github");
    expect(page.querySelector('[data-use="connectors.reconnect"], [data-use="connectors.connect"], [data-use="connectors.add"]')).toBeNull();
    expect([...page.querySelectorAll(".cn-note")].map((one) => one.textContent)).toEqual(["Signed in on the Mac with GitHub's own app.", "This page shows only each account's status: never a key, password or email."]);
  });

  it("titles an Add and labels Claude's code field where it can be seen", async () => {
    openService("claude");
    click('[data-use="connectors.add"]');
    expect(panel()?.querySelector(".cn-signin-title")?.textContent).toBe("Adding a Claude account");
    last().answer(status("a", { state: "waiting", url: URL_A, needsCode: true }));
    await settle();
    const label = panel()?.querySelector<HTMLLabelElement>("label.cn-code-label");
    expect(label?.textContent).toBe("Code from the page");
    const field = panel()?.querySelector<HTMLInputElement>("input.cn-code-field");
    expect(field?.id).toBe(label?.getAttribute("for"));
    expect(field?.getAttribute("type")).toBe("text");
  });

  it("drops a late answer to the code of a sign-in the sheet has left, so it never lands on the next one", async () => {
    openService("claude");
    click('[data-use="connectors.add"]');
    last().answer(status("a", { state: "waiting", url: URL_A, needsCode: true }));
    await settle();
    panel()!.querySelector<HTMLInputElement>("input.cn-code-field")!.value = CODE;
    click('[data-use="connectors.code-send"]');
    const code = last();
    expect(code.path).toBe("/api/connectors/signin/code");
    click('[data-use="connectors.back"]');
    openService("claude");
    click('[data-use="connectors.add"]');
    last().answer(status("b"));
    await settle();
    code.answer(status("a", { state: "signed-in" }));
    await settle();
    expect(words()).toBe("Starting the sign-in on the Mac…");
    expect(panel()?.querySelector('[data-use="connectors.signin-done"]')).toBeNull();
  });

  it("drops a late start answer for a sign-in the sheet has left", async () => {
    openService("claude");
    click('[data-use="connectors.add"]');
    const first = last();
    click('[data-use="connectors.back"]');
    openService("claude");
    click('[data-use="connectors.add"]');
    last().answer(status("b"));
    await settle();
    first.answer(status("a", { state: "waiting", url: URL_A, needsCode: true }));
    await settle();
    expect(words()).toBe("Starting the sign-in on the Mac…");
    expect(panel()?.querySelector('[data-use="connectors.signin-open"]')).toBeNull();
  });
});
