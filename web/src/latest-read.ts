/** One loader's ordering: only its latest started read may apply a result or an error. */
export function latestRead(): { start(): () => boolean; invalidate(): void } {
  let sequence = 0;
  return {
    start() {
      const mine = ++sequence;
      return () => mine === sequence;
    },
    // A landed write or a closed view also supersedes every pending read.
    invalidate() {
      sequence++;
    },
  };
}
