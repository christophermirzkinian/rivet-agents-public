/**
 * No bytes for this long, headers included, and a download has stalled. It is a gap, not a deadline, so a
 * large file on a slow line still comes down while its bytes keep coming.
 */
export const STALL_MS = 20_000;

/** A signal that aborts after STALL_MS with no `touch`, or when `outer` does; `stalled` tells the two apart. */
export function stallWatch(outer?: AbortSignal) {
  const controller = new AbortController();
  let stalled = false;
  const stop = () => controller.abort();
  const arm = () =>
    setTimeout(() => {
      stalled = true;
      stop();
    }, STALL_MS);
  let timer = arm();
  if (outer) {
    if (outer.aborted) stop();
    else outer.addEventListener("abort", stop, { once: true });
  }
  return {
    signal: controller.signal,
    stalled: () => stalled,
    touch() {
      clearTimeout(timer);
      timer = arm();
    },
    done() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", stop);
    },
  };
}

/** Reads a body to its end, each chunk counting as progress for `watch`. */
export async function readBody(response: Response, watch: { touch(): void }, onBytes?: (n: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      watch.touch();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      onBytes?.(value.byteLength);
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
