import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_OWNER_HOLDS, type OwnerHold, type OwnerHoldsResponse } from "../src/shared/owner-holds.js";
import { OpsStore } from "../src/server/ops/store.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, fakeClock, startServer, type TestServer } from "./helpers.js";

// 4:30pm on Sunday 25 Oct local time.
const START = Date.parse("2026-10-25T05:30:00.000Z");
const REASON = "Sam 4:30pm (r_9): 'hold it till I play it'";

let server: TestServer;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  clock = fakeClock(START);
  server = await startServer({}, { now: clock.now });
});

afterEach(async () => {
  await server.close();
});

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = bearer(BOARD_TOKEN)): Promise<Response> {
  return fetch(`${server.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function list(headers?: Record<string, string>): Promise<OwnerHold[]> {
  const response = await send("GET", "/api/ops/holds", undefined, headers);
  expect(response.status).toBe(200);
  return ((await response.json()) as OwnerHoldsResponse).holds;
}

describe("Sam's own holds on the server (rivet hold, 2026-10-25)", () => {
  it("records his hold once, where the Ops pass reads it, and takes it away on unhold", async () => {
    const put = await send("PUT", "/api/ops/holds/6540", { reason: REASON });
    expect(put.status).toBe(201);
    const hold: OwnerHold = { pr: 6540, repo: "example-org/example-repo", reason: REASON, at: new Date(START).toISOString() };
    expect(await put.json()).toEqual({ hold, added: true });
    // A second hold on the PR leaves the first, and its card, as they are.
    clock.advance(60_000);
    const again = await send("PUT", "/api/ops/holds/6540", { reason: "another reason" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ hold, added: false });
    expect((await send("PUT", "/api/ops/holds/6540", { reason: REASON, repo: "example-org/other-repo" })).status).toBe(201);
    expect((await list()).map((one) => [one.pr, one.repo])).toEqual([
      [6540, "example-org/example-repo"],
      [6540, "example-org/other-repo"],
    ]);
    const ops = new OpsStore(server.dataDir);
    expect(ops.get("ownerHolds")?.[0]).toEqual(hold);
    ops.close();

    const removed = await send("DELETE", "/api/ops/holds/6540");
    expect(await removed.json()).toEqual({ removed: 1 });
    expect(await (await send("DELETE", "/api/ops/holds/6540")).json()).toEqual({ removed: 0 });
    expect((await list()).map((one) => one.repo)).toEqual(["example-org/other-repo"]);
    expect(await (await send("DELETE", "/api/ops/holds/6540?repo=example-org/other-repo")).json()).toEqual({ removed: 1 });
    expect(await list()).toEqual([]);
  });

  it("lets a session read but only the board token write", async () => {
    const cookie = server.cookie();
    for (const headers of [{}, browser(cookie), bearer(BRIDGE_TOKEN)]) {
      expect((await send("PUT", "/api/ops/holds/12", { reason: REASON }, headers)).status).toBe(401);
      expect((await send("DELETE", "/api/ops/holds/12", undefined, headers)).status).toBe(401);
    }
    expect((await send("GET", "/api/ops/holds", undefined, {})).status).toBe(401);
    expect((await send("GET", "/api/ops/holds", undefined, bearer(BRIDGE_TOKEN))).status).toBe(401);
    expect(await list(browser(cookie))).toEqual([]);
  });

  it("refuses a hold with no reason, an unknown repo or field, a PR that is not a number, and one past the cap", async () => {
    for (const body of [{}, { reason: "  " }, { reason: "x".repeat(1001) }, { reason: REASON, repo: "someone/else" }, { reason: REASON, by: "agent" }]) {
      expect((await send("PUT", "/api/ops/holds/12", body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const pr of ["0", "012", "12a", "1234567890", "12/13"]) {
      expect((await send("PUT", `/api/ops/holds/${pr}`, { reason: REASON })).status, pr).toBe(400);
    }
    const ops = new OpsStore(server.dataDir);
    ops.put("ownerHolds", Array.from({ length: MAX_OWNER_HOLDS }, (_, i) => ({ pr: 1000 + i, repo: "example-org/example-repo", reason: REASON, at: new Date(START).toISOString() })), new Date(START));
    ops.close();
    expect((await send("PUT", "/api/ops/holds/12", { reason: REASON })).status).toBe(507);
    // One already held still answers as recorded.
    expect((await send("PUT", "/api/ops/holds/1000", { reason: REASON })).status).toBe(200);
    expect(await list()).toHaveLength(MAX_OWNER_HOLDS);
  });
});
