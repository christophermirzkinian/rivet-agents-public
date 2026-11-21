// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The screens before sign-in, on a machine whose server named its app in the page it served.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let enrolled: () => void = () => {};

vi.mock("../web/src/api.js", async (actual) => ({
  ...((await actual()) as typeof import("../web/src/api.js")),
  me: () => Promise.resolve({ signedIn: false }),
  enrol: () => new Promise<void>((done) => (enrolled = done)),
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
});
