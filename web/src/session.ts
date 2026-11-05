// The signed-in session's generation and its resets. An answer to a request made in an earlier session is
// never applied and never signs anyone out; a module that holds what a session read registers its reset here, and
// signing out and signing in both run them.

let session = 0;
const resets: (() => void)[] = [];

/** Whether the session this was called in is still the current one. */
export function sameSession(): () => boolean {
  const at = session;
  return () => at === session;
}

/** Forgets a module's session state whenever a session ends or begins. */
export function onSessionReset(reset: () => void): void {
  resets.push(reset);
}

/** Ends the current session: every request still out answers StaleSession, and every registered reset runs. */
export function endSession(): void {
  session++;
  for (const reset of resets) reset();
}

/** The answer to a request made in an earlier session; it says nothing (describe gives "", flash shows nothing). */
export class StaleSession extends Error {
  constructor() {
    super("");
    this.name = "StaleSession";
  }
}
