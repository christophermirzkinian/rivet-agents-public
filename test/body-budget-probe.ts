import { connect, type Socket } from "node:net";

import { BODY_CHUNK_OVERHEAD_BYTES } from "../src/server/bodyBudget.js";

export interface BodyBudgetProbe {
  port: number;
  host?: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  stalled?: number;
  chunkBytes?: number;
  waitMs?: number;
}

/**
 * The pre-auth body budget seen from outside a real server: opens `stalled` uploads, none of them finished, each charged
 * `chunkBytes` (its body plus one chunk's overhead), then one more upload, and returns the first status line the server
 * sends any of them within `waitMs` (or `null` if it sends none: an unbounded server just keeps reading).
 */
export async function probeBodyBudget({
  port,
  host = "127.0.0.1",
  method = "POST",
  path,
  headers = {},
  stalled = 32,
  chunkBytes = 16 * 1024 - 1,
  waitMs = 3_000,
}: BodyBudgetProbe): Promise<{ status: number | null; response: string; close(): void }> {
  const sockets: Socket[] = [];
  const close = () => {
    for (const socket of sockets) socket.destroy();
  };
  // The first answer any upload gets: a stalled upload whose body arrived in more chunks than one may cross the bound
  // before the last upload does.
  let answer: string | null = null;
  let answered: (text: string) => void = () => {};
  const firstAnswer = new Promise<string>((resolve) => {
    answered = resolve;
  });
  const head = (length: number) =>
    [
      `${method} ${path} HTTP/1.1`,
      `host: ${host}:${port}`,
      "content-type: application/json",
      `content-length: ${length}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n");
  const open = (bytes: number) =>
    new Promise<Socket>((resolve, reject) => {
      let text = "";
      const socket = connect(port, host, () => {
        // A JSON-ish prefix padded with spaces: never complete, never answered.
        socket.write(head(bytes * 4) + "{" + " ".repeat(bytes - 1), () => resolve(socket));
      });
      socket.on("data", (data) => {
        text += String(data);
        if (answer === null && text.includes("\r\n\r\n")) {
          answer = text;
          answered(text);
        }
      });
      socket.on("error", reject);
      sockets.push(socket);
    });
  try {
    if (stalled > 0 && chunkBytes <= BODY_CHUNK_OVERHEAD_BYTES) throw new Error(`chunkBytes must exceed one chunk's overhead (${BODY_CHUNK_OVERHEAD_BYTES})`);
    for (let i = 0; i < stalled; i++) await open(chunkBytes - BODY_CHUNK_OVERHEAD_BYTES);
    // Let the server read every stalled chunk before the last upload arrives.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const last = await open(1024);
    const response = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(answer ?? ""), waitMs);
      void firstAnswer.then((text) => {
        clearTimeout(timer);
        resolve(text);
      });
      last.on("close", () => setTimeout(() => {
        clearTimeout(timer);
        resolve(answer ?? "");
      }, 50));
    });
    const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
    return { status: match ? Number(match[1]) : null, response, close };
  } catch (error) {
    close();
    throw error;
  }
}
