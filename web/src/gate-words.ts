import { WebAuthnError } from "@simplewebauthn/browser";

import { appName } from "../../src/shared/names.js";
import { ApiError } from "./api.js";
import { hostedPage } from "./cloud-agent.js";
import { StaleSession } from "./session.js";

/**
 * What the screens before sign-in, and Settings › Devices, say when the browser or the server refuses (a-10). Only a
 * sentence from this file, or one api.ts wrote itself, reaches them: a text that is not known gets the plain fallback.
 */
export type GateScreen =
  /** Sign in with passkey. */
  | "passkey"
  /** The same, in a window that also offers "Use a code instead". */
  | "passkey-or-code"
  /** A set-up link's Create passkey. */
  | "set-up"
  /** The code field. */
  | "code"
  /** The app's start, before any of them. */
  | "start"
  /** Settings › Devices, signed in. */
  | "devices";

const OTHER = "Something went wrong. Try again in a minute.";
/** The one way back in there is today. Another is named here and in OTHER_WAY once it works, never before. */
const ADD_A_DEVICE = "open Settings › Add a device on a device you're signed in on";
const BAD_CODE = "That code is not valid or has expired.";
const OTHER_WAY: Partial<Record<GateScreen, string>> = {
  passkey: `Try again, or ${ADD_A_DEVICE}, then open its link here.`,
  "passkey-or-code": "Try again, or use a code instead.",
};

/** auth.ts's own refusals, by its exact text (gate-words.test.ts holds the two together). */
const REFUSALS: Record<string, string | ((screen: GateScreen) => string)> = {
  "this enrolment link has been used": `This set-up link was already used. Sign in with the passkey you made, or ${ADD_A_DEVICE}.`,
  "that code is not valid or has expired": (screen) =>
    screen === "code" ? `${BAD_CODE} Get a new one and try again.` : `${BAD_CODE} Open Settings › Add a device on a device you're signed in on, then open its new link here.`,
  "an enrolment code is required": "This set-up link has no code in it. Open the whole link again.",
  "enrolment is not configured": `This set-up link can't be used here. To use this device, ${ADD_A_DEVICE}, then open its link here.`,
  "sign-in attempt expired, start again": "That didn't go through. Try again.",
  "passkey could not be verified": "That passkey could not be checked. Try again.",
  "this passkey is already registered": "This passkey is already set up here. Sign in below.",
  "this passkey is not registered here": (screen) => `That passkey is not set up here. ${OTHER_WAY[screen] ?? "Try again."}`,
  "too many attempts, wait a minute": "Too many tries. Wait a minute, then try again.",
  "sign in first": "Your session ended. Sign in again.",
};

function refusal(error: ApiError, screen: GateScreen): string {
  // Status 0 is a request api.ts gave up on itself, in its own plain words: no server wrote them.
  if (error.status === 0) return error.message;
  // Whatever refused it, the code screen's 403 has always been the one sentence.
  const text = screen === "code" && error.status === 403 ? "that code is not valid or has expired" : error.message;
  const words = Object.hasOwn(REFUSALS, text) ? REFUSALS[text]! : OTHER;
  return typeof words === "string" ? words : words(screen);
}

/** The browser's own refusals: it does not tell a closed box, a time-out and a missing passkey apart, so no line says which. */
function browserRefusal(error: unknown, screen: GateScreen): string {
  if (screen === "code" || screen === "start" || screen === "devices") return OTHER;
  if (typeof PublicKeyCredential === "undefined") {
    return screen === "passkey-or-code" ? "This browser can't use passkeys. Use a code instead." : "This browser can't use passkeys. Try another browser.";
  }
  // Only the passkey library's own refusal says the passkey step failed: anything else may have come after it worked.
  if (!(error instanceof WebAuthnError)) return OTHER;
  const { name } = error;
  if (screen === "set-up") {
    if (name === "InvalidStateError") return "This device may already have a passkey here. Sign in below.";
    if (name === "NotAllowedError" || name === "AbortError") return "No passkey was made. The box may have been closed or timed out. Tap Create passkey to try again.";
    return "No passkey was made. Try again, or open this link on another device.";
  }
  return `That didn't sign you in. This device may not have a passkey for ${hostedPage() ? "this agent" : appName()}. ${OTHER_WAY[screen]!}`;
}

export function gateWords(error: unknown, screen: GateScreen): string {
  // The page moved on before the answer: nothing is said, as before.
  if (error instanceof StaleSession) return "";
  return error instanceof ApiError ? refusal(error, screen) : browserRefusal(error, screen);
}
