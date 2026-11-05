import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { createRouter, type RouteDeps } from "../src/server/routes/router.js";

const request = (method: string) => ({ method }) as IncomingMessage;
const response = {} as ServerResponse;

describe("createRouter", () => {
  it("runs the route for an exact method and path, and only that one", async () => {
    const router = createRouter({} as RouteDeps);
    const hits: string[] = [];
    router.on("GET", "/api/ops", ({ url }) => {
      hits.push(url.pathname);
    });
    expect(await router.dispatch(request("GET"), response, new URL("http://x/api/ops?x=1"))).toBe(true);
    expect(await router.dispatch(request("POST"), response, new URL("http://x/api/ops"))).toBe(false);
    expect(await router.dispatch(request("GET"), response, new URL("http://x/api/ops/1"))).toBe(false);
    expect(hits).toEqual(["/api/ops"]);
  });

  it("refuses a method and path registered twice", () => {
    const router = createRouter({} as RouteDeps);
    router.on("PUT", "/api/command", () => {});
    expect(() => router.on("PUT", "/api/command", () => {})).toThrow(/registered twice/);
  });
});
