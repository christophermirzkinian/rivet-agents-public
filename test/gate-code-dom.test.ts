// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sign-in screen's code offer: only from a server that takes a device code alone, in a window that cannot make a passkey.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let me: { signedIn: boolean; deviceSession?: true; via?: "device-code" } = { signedIn: false };
/** How many times the page asked the server who it is; `slow` leaves each one unanswered. */
let asked = 0;
let slow = false;
const deviceSession = vi.fn<(code: string) => Promise<{ ok: true }>>();

vi.mock("../web/src/api.js", async (actual) => ({
  ...((await actual()) as typeof import("../web/src/api.js")),
  me: () => {
    asked += 1;
    return slow ? new Promise(() => {}) : Promise.resolve(me);
  },
  deviceSession: (code: string) => deviceSession(code),
}));

const text = (selector: string) => document.querySelector(selector)?.textContent ?? null;
const use = (id: string) => document.querySelector<HTMLButtonElement>(`[data-use="${id}"]`);
/** The window's passkey maker: `platform` is what it answers for one of its own; null is a window with no passkeys at all. */
const passkeys = (platform: boolean | null | Error) =>
  vi.stubGlobal(
    "PublicKeyCredential",
    platform === null
      ? undefined
      : { isUserVerifyingPlatformAuthenticatorAvailable: () => (platform instanceof Error ? Promise.reject(platform) : Promise.resolve(platform)) },
  );

async function open(): Promise<void> {
  await import("../web/src/main.js");
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  deviceSession.mockReset();
  me = { signedIn: false };
  asked = 0;
  slow = false;
  vi.stubGlobal("fetch", vi.fn((path: string) => (path === "/cloud/agent" ? new Promise(() => {}) : Promise.resolve(json({ error: "not found" }, 404)))));
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "app" }));
});

afterEach(() => {
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  document.head.replaceChildren();
});

describe("the sign-in screen's code offer", () => {
  it.each([
    ["the server does not offer it and the window has no passkeys", undefined, null],
    ["the server does not offer it and the window has no passkey maker of its own", undefined, false],
    ["the server offers it and the window can make a passkey", true, true],
    ["the server offers it and the window's answer fails", true, new Error("no answer")],
  ] as const)("is not there when %s", async (_name, offered, platform) => {
    me = { signedIn: false, ...(offered ? { deviceSession: true } : {}) };
    passkeys(platform);
    await open();
    expect(document.querySelector(".gate-code")).toBeNull();
    expect(use("gate.signin-code")).toBeNull();
    expect(use("gate.code")).toBeNull();
    expect([...document.querySelectorAll(".gate button")].map((button) => button.textContent)).toEqual(["Sign in with passkey"]);
    expect(text(".gate-step-title")).toBe("Use your passkey");
  });

  it.each([
    ["has no passkeys", null],
    ["has no passkey maker of its own", false],
  ] as const)("opens on the code when the server offers it and the window %s, naming the app and where the code is", async (_name, platform) => {
    const meta = Object.assign(document.createElement("meta"), { name: "application-name", content: "Acme Agents" });
    document.head.replaceChildren(meta);
    me = { signedIn: false, deviceSession: true };
    passkeys(platform);
    await open();
    expect(text(".gate-name")).toBe("Acme Agents");
    expect(text(".gate-step-title")).toBe("Use a code from a signed-in device");
    expect(text(".gate-step-sub")).toBe("On a phone signed in to Acme Agents, open Settings › Add a device.");
    expect(document.querySelector(".gate")!.textContent).not.toMatch(/Rivet|Rivet/);
    const field = document.querySelector<HTMLInputElement>(".gate-code")!;
    expect(field.getAttribute("maxlength")).toBe("8");
    expect(field.getAttribute("aria-label")).toBe("Code from a signed-in device");
    expect([...document.querySelectorAll(".gate button")].map((button) => button.textContent)).toEqual(["Sign in with code", "Use a passkey instead"]);
  });

  it("sends the code once, says a refused one is not valid, and takes another", async () => {
    me = { signedIn: false, deviceSession: true };
    passkeys(false);
    await open();
    const { ApiError } = await import("../web/src/api.js");
    const field = document.querySelector<HTMLInputElement>(".gate-code")!;
    use("gate.code")!.click();
    expect(deviceSession).not.toHaveBeenCalled();

    let refuse: (error: unknown) => void = () => {};
    deviceSession.mockReturnValueOnce(new Promise((_done, fail) => (refuse = fail)));
    field.value = " abcd2345 ";
    use("gate.code")!.click();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(deviceSession.mock.calls).toEqual([["abcd2345"]]);
    expect(text(".gate-status")).toBe("Checking the code…");
    refuse(new ApiError(403, "that code is not valid or has expired"));
    await flush();
    expect(text(".gate-status")).toBe("That code is not valid or has expired. Get a new one and try again.");

    deviceSession.mockReturnValueOnce(Promise.reject(new ApiError(429, "too many attempts, wait a minute")));
    field.value = "WXYZ6789";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(deviceSession.mock.calls).toEqual([["abcd2345"], ["WXYZ6789"]]);
    expect(text(".gate-status")).toBe("too many attempts, wait a minute");
  });

  it("shows the passkey screen when the window never answers about its passkey maker", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      me = { signedIn: false, deviceSession: true };
      vi.stubGlobal("PublicKeyCredential", { isUserVerifyingPlatformAuthenticatorAvailable: () => new Promise(() => {}) });
      await import("../web/src/main.js");
      await vi.advanceTimersByTimeAsync(1499);
      expect(document.querySelector(".gate")).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect([...document.querySelectorAll(".gate button")].map((button) => button.textContent)).toEqual(["Sign in with passkey"]);
      expect(document.querySelector(".gate-code")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("from a set-up link", () => {
    const link = (hash: string) => history.replaceState(null, "", `/${hash}`);
    const buttons = () => [...document.querySelectorAll(".gate button")].map((button) => button.textContent);

    it("puts the link's code in the field and sends it only on a tap, with the code gone from the address", async () => {
      me = { signedIn: false, deviceSession: true };
      passkeys(false);
      link("#code=abcd2345");
      await open();
      expect(location.hash).toBe("");
      expect(location.href).not.toContain("abcd2345");
      expect(document.querySelector<HTMLInputElement>(".gate-code")!.value).toBe("ABCD2345");
      expect([...document.querySelectorAll(".gate-step-title")].map((title) => title.textContent)).toEqual(["Set-up link opened", "Sign in with the code"]);
      expect(buttons()).toEqual(["Sign in with code", "Create a passkey instead"]);
      await flush();
      expect(deviceSession).not.toHaveBeenCalled();

      deviceSession.mockReturnValueOnce(new Promise(() => {}));
      use("gate.code")!.click();
      expect(deviceSession.mock.calls).toEqual([["ABCD2345"]]);
    });

    it("keeps the link's passkey set-up a tap away", async () => {
      me = { signedIn: false, deviceSession: true };
      passkeys(null);
      link("#code=ABCD2345");
      await open();
      use("gate.code-enrol")!.click();
      expect(document.querySelector(".gate-code")).toBeNull();
      expect(buttons()).toEqual(["Create passkey", "I already have one: sign in"]);
    });

    it.each([
      ["the server does not offer a code alone", undefined, false, "#code=ABCD2345"],
      ["the window can make a passkey", true, true, "#code=ABCD2345"],
      ["the link's code is not a device code", true, false, "#code=a-long-enrolment-token"],
      ["the link is a bare enrolment token", true, false, "#a-long-enrolment-token"],
    ] as const)("opens the passkey set-up as before when %s", async (_name, offered, platform, hash) => {
      me = { signedIn: false, ...(offered ? { deviceSession: true } : {}) };
      passkeys(platform);
      link(hash);
      await open();
      expect(location.hash).toBe("");
      expect(document.querySelector(".gate-code")).toBeNull();
      expect(buttons()).toEqual(["Create passkey", "I already have one: sign in"]);
      expect(deviceSession).not.toHaveBeenCalled();
      // Only a window that cannot make a passkey, holding a link that could be a device code, asks the server.
      expect(asked).toBe(platform === false && hash === "#code=ABCD2345" ? 1 : 0);
    });

    it("opens the passkey set-up at once, with no request, in a window that can make a passkey", async () => {
      slow = true;
      passkeys(true);
      link("#code=ABCD2345");
      await open();
      expect(buttons()).toEqual(["Create passkey", "I already have one: sign in"]);
      expect(asked).toBe(0);
      expect(vi.mocked(fetch).mock.calls.map(([path]) => path).filter((path) => path !== "/cloud/agent")).toEqual([]);
    });

    it("asks the server once in a window that cannot make a passkey", async () => {
      me = { signedIn: false, deviceSession: true };
      passkeys(false);
      link("#code=ABCD2345");
      await open();
      expect(asked).toBe(1);
      expect(document.querySelector(".gate-code")).not.toBeNull();
    });
  });

  describe("on a device already signed in", () => {
    it("opens the app without waiting for the window's answer about its passkey maker", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        me = { signedIn: true, deviceSession: true };
        vi.stubGlobal("PublicKeyCredential", { isUserVerifyingPlatformAuthenticatorAvailable: () => new Promise(() => {}) });
        await import("../web/src/main.js");
        await vi.advanceTimersByTimeAsync(1);
        expect(document.querySelector(".gate")).toBeNull();
        expect(document.querySelector(".topbar")).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("still opens on the code after a later sign-out, where the window cannot make a passkey", async () => {
      me = { signedIn: true, deviceSession: true };
      passkeys(false);
      await open();
      expect(document.querySelector(".topbar")).not.toBeNull();
      (await import("../web/src/state.js")).signedOut("Signed out.");
      expect(document.querySelector(".gate-code")).not.toBeNull();
      expect(text(".gate-status")).toBe("Signed out.");
    });

    it("knows as the app opens whether a code alone signed the window in, forgets at a sign-out, and knows again after the next code", async () => {
      me = { signedIn: true, deviceSession: true, via: "device-code" };
      passkeys(false);
      await open();
      const session = await import("../web/src/session.js");
      expect(session.signedInByCode()).toBe(true);
      (await import("../web/src/state.js")).signedOut("Signed out.");
      expect(session.signedInByCode()).toBeNull();
      deviceSession.mockResolvedValueOnce({ ok: true });
      document.querySelector<HTMLInputElement>(".gate-code")!.value = "abcd2345";
      use("gate.code")!.click();
      await flush();
      expect(document.querySelector(".topbar")).not.toBeNull();
      expect(session.signedInByCode()).toBe(true);
    });

    it("does not take a passkey's window for one, on a server that offers the code", async () => {
      me = { signedIn: true, deviceSession: true };
      passkeys(false);
      await open();
      expect((await import("../web/src/session.js")).signedInByCode()).toBe(false);
    });
  });

  it("goes to the passkey screen and back", async () => {
    me = { signedIn: false, deviceSession: true };
    passkeys(false);
    await open();
    use("gate.code-passkey")!.click();
    expect(document.querySelector(".gate-code")).toBeNull();
    expect([...document.querySelectorAll(".gate button")].map((button) => button.textContent)).toEqual(["Sign in with passkey", "Use a code instead"]);
    use("gate.signin-code")!.click();
    expect(document.querySelector(".gate-code")).not.toBeNull();
    expect(use("gate.signin")).toBeNull();
  });
});
