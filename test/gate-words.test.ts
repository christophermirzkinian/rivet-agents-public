// @vitest-environment happy-dom
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebAuthnError } from "@simplewebauthn/browser";

import { ApiError, NoPlan } from "../web/src/api.js";
import { describe as describeError } from "../web/src/dom.js";
import { gateWords, type GateScreen } from "../web/src/gate-words.js";
import { StaleSession } from "../web/src/session.js";

// What a person reads when a sign-in fails (a-1020): never the browser's or the server's own text.

const SCREENS: GateScreen[] = ["passkey", "passkey-or-code", "set-up", "code", "start", "devices"];
const OTHER = "Something went wrong. Try again in a minute.";
const BROWSER_TEXT = "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.";
/** As the passkey library hands a browser refusal on: its own class, the browser's text, the browser's name. */
const browser = (name: string) =>
  new WebAuthnError({ message: BROWSER_TEXT, code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", cause: Object.assign(new Error(BROWSER_TEXT), { name }) });
const RAW = /enrol|grant|webauthn|w3\.org|https?:|cross-origin|internal error|request failed|credential|\b[45]\d\d\b/i;

/** Every refusal auth.ts can send, read from its source so a new one fails here until it has words. */
const authSource = readFileSync("src/server/auth.ts", "utf8");
const sent = [...authSource.matchAll(/new HttpError\(\s*(\d+),\s*"([^"]+)"/g)].map(([, status, text]) => ({ status: Number(status), text: text! }));
/** Sent only to a request the page never makes, or where the page says something else first (settings.ts, device-code). */
const NO_WORDS = new Set(["invalid request", "method not allowed", "not found", "sign in with a passkey to add a device"]);

beforeEach(() => vi.stubGlobal("PublicKeyCredential", {}));
afterEach(() => vi.unstubAllGlobals());

describe("the server's refusals", () => {
  it("are all found in auth.ts, none built some other way", () => {
    expect(sent.length).toBe(authSource.split("new HttpError(").length - 1);
    expect(sent.length).toBeGreaterThan(15);
  });

  it.each([...new Set(sent.map((one) => one.text))].filter((text) => !NO_WORDS.has(text)))("'%s' has words of its own", (text) => {
    const status = sent.find((one) => one.text === text)!.status;
    for (const screen of SCREENS) {
      const words = gateWords(new ApiError(status, text), screen);
      expect(words).not.toBe(OTHER);
      expect(words).not.toBe(text);
      expect(words).not.toMatch(RAW);
      expect(words).toMatch(/^[A-Z].*\.$/);
      expect(words.split(/[.?!](?:\s|$)/).filter(Boolean).length).toBeLessThanOrEqual(3);
    }
  });

  it.each([
    ...[...NO_WORDS].map((text) => [400, text] as const),
    [403, "cross-origin request refused"],
    [500, "internal error"],
    [502, "Request failed (502)"],
    [403, "passkey-only"],
    [404, "constructor"],
    [404, "__proto__"],
  ] as const)("%i '%s' is the plain fallback", (status, text) => {
    for (const screen of SCREENS.filter((one) => one !== "code")) expect(gateWords(new ApiError(status, text), screen)).toBe(OTHER);
  });

  it("say no more of a code than the server does: one sentence for a wrong, used, expired and unknown one", () => {
    expect(sent.filter((one) => one.text === "that code is not valid or has expired").map((one) => one.status)).toEqual([403, 403, 403]);
    const refused = new ApiError(403, "that code is not valid or has expired");
    expect(gateWords(refused, "code")).toBe("That code is not valid or has expired. Get a new one and try again.");
    for (const text of ["this enrolment link has been used", "cross-origin request refused", "passkey-only"]) {
      expect(gateWords(new ApiError(403, text), "code")).toBe(gateWords(refused, "code"));
    }
    expect(gateWords(refused, "set-up")).toBe(
      "That code is not valid or has expired. Open Settings › Add a device on a device you're signed in on, then open its new link here.",
    );
  });

  it("a used set-up link", () => {
    expect(gateWords(new ApiError(403, "this enrolment link has been used"), "set-up")).toBe(
      "This set-up link was already used. Sign in with the passkey you made, or open Settings › Add a device on a device you're signed in on.",
    );
  });

  it("the app's own words for a request that never landed stay", () => {
    const words = "Can't reach the server. Check your connection.";
    for (const screen of SCREENS) expect(gateWords(new ApiError(0, words), screen)).toBe(words);
  });

  it("a page that moved on says nothing, and a missing plan is the plain fallback", () => {
    for (const screen of SCREENS) expect(gateWords(new StaleSession(), screen)).toBe("");
    for (const screen of SCREENS) expect(gateWords(new NoPlan(), screen)).toBe(OTHER);
  });
});

describe("the browser's refusals", () => {
  it.each(["NotAllowedError", "AbortError", "SecurityError", "UnknownError", "InvalidStateError"])("%s on sign-in is one line that claims no cause", (name) => {
    expect(gateWords(browser(name), "passkey")).toMatch(/^That didn't sign you in\. This device may not have a passkey for .+\. Try again, or open Settings › Add a device on a device you're signed in on, then open its link here\.$/);
    expect(gateWords(browser(name), "passkey-or-code")).toMatch(/ Try again, or use a code instead\.$/);
  });

  it("a set-up that made no passkey", () => {
    for (const name of ["NotAllowedError", "AbortError"]) {
      expect(gateWords(browser(name), "set-up")).toBe("No passkey was made. The box may have been closed or timed out. Tap Create passkey to try again.");
    }
    expect(gateWords(browser("InvalidStateError"), "set-up")).toBe("This device may already have a passkey here. Sign in below.");
    expect(gateWords(browser("NotSupportedError"), "set-up")).toBe("No passkey was made. Try again, or open this link on another device.");
  });

  it("a browser with no passkeys", () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    const error = new Error("WebAuthn is not supported in this browser");
    expect(gateWords(error, "passkey")).toBe("This browser can't use passkeys. Try another browser.");
    expect(gateWords(error, "set-up")).toBe("This browser can't use passkeys. Try another browser.");
    expect(gateWords(error, "passkey-or-code")).toBe("This browser can't use passkeys. Use a code instead.");
  });

  it("are told from a fault that is not the passkey step's: a bad answer after the passkey was made does not say none was", () => {
    for (const error of [new TypeError("Cannot read properties of null (reading 'error')"), new DOMException("The user aborted a request.", "AbortError"), new Error("x")]) {
      for (const screen of SCREENS) expect(gateWords(error, screen)).toBe(OTHER);
    }
  });

  it("never reach a screen as they are", () => {
    for (const screen of SCREENS) {
      for (const error of [browser("NotAllowedError"), new TypeError("x is not a function"), "a string", null, undefined]) {
        const words = gateWords(error, screen);
        expect(words).not.toMatch(RAW);
        expect(words).not.toContain("x is not");
      }
    }
  });

  it("a refusal that is not a passkey's is not called one", () => {
    expect(describeError(new DOMException("Registration failed - permission denied", "NotAllowedError"))).toBe("Your browser didn't allow that.");
  });
});
