import type { IncomingMessage, ServerResponse } from "node:http";

import type { PrLifecycle } from "../claims.js";
import type { Config } from "../config.js";
import type { BridgeChannel } from "../events.js";
import type { OpsStore } from "../ops/store.js";
import type { PushService } from "../push.js";
import type { QuietStore } from "../quiet.js";
import type { SchedulesStore } from "../schedules.js";
import type { ShortTitles } from "../short-titles.js";
import type { Store } from "../store.js";
import type { Need } from "../../shared/board.js";
import type { WorkersResponse } from "../../shared/workers.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}

/** Answers the request, or throws an HttpError; http.ts turns anything else into a 500. */
export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

export interface RouteDeps {
  config: Config;
  store: Store;
  bridge: BridgeChannel;
  /** Throws 401 unless the request carries the owner's session. */
  requireSession(request: IncomingMessage): void;
  /** The one push sender; quiet hours apply to every push it sends. */
  push: PushService;
  quiet: QuietStore;
  /** The failing-schedule cards, which every "needs you" count includes (openBoard). */
  schedules: SchedulesStore;
  /** Never given a secret, a token or a request body. */
  logger: Pick<Console, "error">;
  /** The clock chat windows are timed by; tests move it. */
  now(): Date;
  /**
   * Adds an update card as `PUT /api/board/needs/<id>?create=only` does, its push included: 200, or the refusal (409
   * when the id is taken). `replaces`: the pattern of the caller's own ids alone; the cards it matches leave in the same write.
   */
  addUpdate(card: { id: string } & Record<string, unknown>, options?: { progress?: boolean; replaces?: RegExp }): { status: number; error?: string };
  /** Makes the wait cards again after a write outside the board (asks/waits.ts). */
  refreshWaits(): void;
  /** Tells the board which ids are your own chat lines, so an update card answering one is refused (an outcome). */
  ownerLines(check: (id: string) => boolean): void;
  /** Tells the reply route how to read the conversation titles an open card shows (its top line's thread). */
  cardThreadTitles(lookup: (need: Need) => string[]): void;
  /** The live chats as GET /api/workers shows them. */
  workers(): WorkersResponse;
  /** The PRs as the bridge last read them: merged, closed, and open (null when that read failed). */
  prs(): PrLifecycle;
  /** The rows' short titles: the lists read them, the bridge's Haiku pass writes them. */
  titles: ShortTitles;
  /** The Ops readings the bridge last sent, read-only. */
  ops: Pick<OpsStore, "get">;
}

export interface Router {
  readonly deps: RouteDeps;
  /** Adds an exact-path route. A method and path pair registers once. */
  on(method: Method, path: string, handler: RouteHandler): void;
  /** Adds a route for every path under `prefix` (which ends in "/"); exact routes win. */
  onPrefix(method: Method, prefix: string, handler: RouteHandler): void;
  /** Runs when the app closes: stop an area's timers and close its connections here. */
  onClose(fn: () => void): void;
}

export interface Dispatcher extends Router {
  /** True when a route matched and has run. */
  dispatch(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
  close(): void;
}

export function createRouter(deps: RouteDeps): Dispatcher {
  const routes = new Map<string, RouteHandler>();
  const prefixes: { method: Method; prefix: string; handler: RouteHandler }[] = [];
  const closers: (() => void)[] = [];
  return {
    deps,
    on(method, path, handler) {
      const key = `${method} ${path}`;
      if (routes.has(key)) throw new Error(`route registered twice: ${key}`);
      routes.set(key, handler);
    },
    onPrefix(method, prefix, handler) {
      if (!prefix.endsWith("/")) throw new Error(`prefix must end in /: ${prefix}`);
      if (prefixes.some((entry) => entry.method === method && entry.prefix === prefix)) throw new Error(`route registered twice: ${method} ${prefix}`);
      prefixes.push({ method, prefix, handler });
    },
    onClose(fn) {
      closers.push(fn);
    },
    async dispatch(request, response, url) {
      const method = request.method ?? "GET";
      const handler =
        routes.get(`${method} ${url.pathname}`) ??
        prefixes.find((entry) => entry.method === method && url.pathname.startsWith(entry.prefix) && url.pathname.length > entry.prefix.length)?.handler;
      if (!handler) return false;
      await handler({ request, response, url });
      return true;
    },
    close() {
      for (const fn of closers.splice(0)) fn();
    },
  };
}
