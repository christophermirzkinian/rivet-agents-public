import net from "node:net";

/** A loopback port no Rivet Agents service listens on; holding it is holding the one-daemon lock. */
export const LOCK_PORT = 47631;

/**
 * Takes the one-daemon lock: a listening socket on 127.0.0.1:LOCK_PORT. A second daemon would drain actions the first
 * was also given: the server sends a card merge again when a reconnecting bridge says it never received it, and only
 * one receiver makes that safe. The kernel binds the port to one process at a time and frees it when that process
 * exits however it ends, so there is no stale lock to take over and no race in taking one.
 * @param {{ port?: number }} [options]
 * @returns {Promise<{ ok: true, release: () => Promise<void> } | { ok: false, reason: string }>}
 */
export function acquireInstanceLock({ port = LOCK_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", (err) => {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === "EADDRINUSE") resolve({ ok: false, reason: `127.0.0.1:${port} is held (another bridge is running)` });
      else reject(err);
    });
    // exclusive: a cluster worker would otherwise share the handle.
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.unref();
      resolve({ ok: true, release: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
