// Entrypoint guard for repo scripts. Node realpaths the main module for
// `import.meta.url` but leaves `process.argv[1]` as invoked, so a script run
// through a symlink (a symlinked worktree, a bin shim) never matched the
// unresolved comparison and exited 0 having run nothing. Under
// --preserve-symlinks-main it is the other way round, so both sides are
// canonicalised.

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export function isMain(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  if (importMetaUrl === pathToFileURL(argv1).href) return true;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
