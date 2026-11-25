// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebAuthnError } from "@simplewebauthn/browser";

// The screens before sign-in, on a machine whose server named its app in the page it served.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let enrolled: () => void = () => {};
let refused: (error: unknown) => void = () => {};

vi.mock("../web/src/api.js", async (actual) => ({
  ...((await actual()) as typeof import("../web/src/api.js")),
  me: () => Promise.resolve({ signedIn: false }),
  enrol: () => new Promise<void>((done, fail) => ((enrolled = done), (refused = fail))),
  signIn: () => new Promise<void>((_done, fail) => (refused = fail)),
}));

const served = (app: string) => {
  const meta = document.createElement("meta");
  meta.name = "application-name";
  meta.content = app;
  document.head.replaceChildren(meta);
};

beforeEach(() => {
  vi.resetModules();
  // The supervisor's answer never comes in these tests: the screen is read while it is still asked.
  vi.stubGlobal("fetch", vi.fn((path: string) => (path === "/cloud/agent" ? new Promise(() => {}) : Promise.resolve(json({ error: "not found" }, 404)))));
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "app" }));
});

afterEach(() => {
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  document.head.replaceChildren();
});

describe("the gate on a hosted machine", () => {
  it("says the host's app name on sign-in", async () => {
    served("Acme Agents");
    await import("../web/src/main.js");
    await flush();
    expect(document.querySelector(".gate-name")!.textContent).toBe("Acme Agents");
  });

  it("names the host's app on enrol, and says it is finishing setup once the passkey is made", async () => {
    served("Acme Agents");
    history.replaceState(null, "", "/#code=abc");
    await import("../web/src/main.js");
    await flush();
    expect(document.querySelector(".gate-name")!.textContent).toBe("Acme Agents");
    document.querySelector<HTMLButtonElement>('[data-use="gate.enrol"]')!.click();
    const status = document.querySelector(".gate-status")!;
    expect(status.textContent).toBe("Waiting for your passkey…");
    enrolled();
    await flush();
    expect(status.textContent).toBe("Passkey made. Finishing setup…");
  });

  describe("says a refusal in plain words", () => {
    const RAW = "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.";
    const browser = () => new WebAuthnError({ message: RAW, code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", cause: Object.assign(new Error(RAW), { name: "NotAllowedError" }) });
    const says = async (use: string, error: unknown): Promise<string> => {
      document.querySelector<HTMLButtonElement>(`[data-use="${use}"]`)!.click();
      refused(error);
      await flush();
      return document.querySelector(".gate-status")!.textContent!;
    };

    beforeEach(() => {
      vi.stubGlobal("PublicKeyCredential", {});
      served("Acme Agents");
      document.head.append(Object.assign(document.createElement("meta"), { name: "hosted-agent", content: "1" }));
    });

    it("on sign-in", async () => {
      await import("../web/src/main.js");
      const { ApiError } = await import("../web/src/api.js");
      await flush();
      expect(await says("gate.signin", browser())).toBe(
        "That didn't sign you in. This device may not have a passkey for this agent. Try again, or open Settings › Add a device on a device you're signed in on, then open its link here.",
      );
      expect(await says("gate.signin", new ApiError(403, "this passkey is not registered here"))).toBe(
        "That passkey is not set up here. Try again, or open Settings › Add a device on a device you're signed in on, then open its link here.",
      );
      expect(await says("gate.signin", new ApiError(502, "Request failed (502)"))).toBe("Something went wrong. Try again in a minute.");
    });

    it("on a set-up link", async () => {
      history.replaceState(null, "", "/#code=abc");
      await import("../web/src/main.js");
      const { ApiError } = await import("../web/src/api.js");
      await flush();
      expect(await says("gate.enrol", new ApiError(403, "this enrolment link has been used"))).toBe(
        "This set-up link was already used. Sign in with the passkey you made, or open Settings › Add a device on a device you're signed in on.",
      );
      expect(await says("gate.enrol", browser())).toBe("No passkey was made. The box may have been closed or timed out. Tap Create passkey to try again.");
      expect(await says("gate.enrol", new ApiError(403, "a text nobody has written yet"))).toBe("Something went wrong. Try again in a minute.");
    });
  });
});
