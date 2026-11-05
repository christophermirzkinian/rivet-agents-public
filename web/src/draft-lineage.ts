/** Tracks each pending send's draft descendants across chat unmounts. */
export function createDraftLineage() {
  const pending = new Set<Set<string | null>>();

  return {
    begin(revision: string | null) {
      const revisions = new Set([revision]);
      pending.add(revisions);
      return {
        owns: (current: string | null) => revisions.has(current),
        finish: () => { pending.delete(revisions); },
      };
    },
    /** Call only after saving both the draft and its new revision successfully. */
    saved(previous: string | null, next: string) {
      // Missing storage is not an identity from which to adopt a new draft.
      if (previous === null) return;
      for (const revisions of pending) {
        if (revisions.has(previous)) revisions.add(next);
      }
    },
  };
}
