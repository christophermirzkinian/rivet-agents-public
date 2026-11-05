import { ExecError } from "./config.mjs";
import { isTransient } from "./github-classifier.mjs";

/** Classify actual child failures, never a local guard's error text. */
export function isTransientExec(err) {
  return err instanceof ExecError ? err.transientGitHub : isTransient(err);
}
