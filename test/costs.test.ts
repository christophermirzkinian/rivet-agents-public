import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error the CLI is plain ESM without type declarations
import { run } from "../scripts/rivet.mjs";
import { COST_FX, costsView, MAX_COSTS, type CostRow, type CostsResponse } from "../src/shared/costs.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, browser, fakeClock, startServer, type TestServer } from "./helpers.js";

const NOW = "2026-10-09T00:00:00.000Z";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = await startServer({}, { now: fakeClock(Date.parse(NOW)).now });
  cookie = server.cookie();
});

afterEach(async () => {
  await server.close();
});

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = bearer(BOARD_TOKEN)): Promise<Response> {
  return fetch(`${server.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function costs(headers: Record<string, string> = browser(cookie)): Promise<CostsResponse> {
  const response = await send("GET", "/api/costs", undefined, headers);
  expect(response.status).toBe(200);
  return (await response.json()) as CostsResponse;
}

/** rivet.mjs against the test server, with the board token from the environment. */
async function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const env = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: BOARD_TOKEN, RIVET_URL: server.base, PATH: "" };
  const code: number = await run(argv, { env, stdout: (s: string) => void (stdout += s), stderr: (s: string) => void (stderr += s) });
  return { code, stdout, stderr };
}

describe("costs routes", () => {
  it("Rivet sets a row with the board token; Sam's session reads it with the totals", async () => {
    const created = await send("PUT", "/api/costs/claude", { name: "Claude 4× Max 20x", aud: 1150, kind: "actual", note: "US$800" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ service: "claude", name: "Claude 4× Max 20x", aud: 1150, kind: "actual", note: "US$800", checkedAt: NOW });
    expect((await send("PUT", "/api/costs/hosting", { name: "Hosting", aud: 415, kind: "actual", checkedAt: "2026-10-07T01:00:00+11:00" })).status).toBe(201);
    // A second set replaces the whole row: its note goes when the set has none.
    expect((await send("PUT", "/api/costs/claude", { name: "Claude 4× Max 20x", aud: 1146.4, kind: "actual" })).status).toBe(200);

    const view = await costs();
    expect(view.rows.map((row) => [row.service, row.aud, row.note, row.checkedAt])).toEqual([
      ["claude", 1146.4, undefined, NOW],
      ["hosting", 415, undefined, "2026-10-06T14:00:00.000Z"],
    ]);
    expect(view.monthAud).toBe(1561);
    expect(view.yearAud).toBe(18737);
    expect(view.fx).toEqual(COST_FX);
    // Rivet reads the list with its own token too.
    expect((await costs(bearer(BOARD_TOKEN))).rows).toHaveLength(2);
  });

  it("refuses readers and writers without the right credential, and bad rows", async () => {
    expect((await send("GET", "/api/costs", undefined, {})).status).toBe(401);
    expect((await send("GET", "/api/costs", undefined, bearer(BRIDGE_TOKEN))).status).toBe(401);
    const row = { name: "Image tool", aud: 30, kind: "estimate" };
    expect((await send("PUT", "/api/costs/image-tool", row, bearer(BRIDGE_TOKEN))).status).toBe(401);
    expect((await send("PUT", "/api/costs/image-tool", row, browser(cookie))).status).toBe(401);
    expect((await send("DELETE", "/api/costs/image-tool", undefined, browser(cookie))).status).toBe(401);
    for (const bad of [{ ...row, kind: "guess" }, { ...row, aud: -1 }, { ...row, name: "two\nlines" }, { ...row, extra: 1 }, { name: "Image tool", kind: "estimate" }])
      expect((await send("PUT", "/api/costs/image-tool", bad)).status).toBe(400);
    expect((await send("PUT", "/api/costs/Image-tool", row)).status).toBe(400);
    expect((await send("DELETE", "/api/costs/image-tool")).status).toBe(404);
    expect((await costs()).rows).toEqual([]);
  });

  it("drops a row, and holds at most MAX_COSTS", async () => {
    for (let i = 0; i < MAX_COSTS; i++) expect((await send("PUT", `/api/costs/s${i}`, { name: `S${i}`, aud: 1, kind: "estimate" })).status).toBe(201);
    expect((await send("PUT", "/api/costs/one-more", { name: "One more", aud: 1, kind: "estimate" })).status).toBe(507);
    // A set of a row it holds still goes through.
    expect((await send("PUT", "/api/costs/s0", { name: "S0", aud: 2, kind: "estimate" })).status).toBe(200);
    expect((await send("DELETE", "/api/costs/s0")).status).toBe(200);
    expect((await send("PUT", "/api/costs/one-more", { name: "One more", aud: 1, kind: "estimate" })).status).toBe(201);
  });
});

describe("costsView", () => {
  const row = (service: string, aud: number, kind: CostRow["kind"], checkedAt: string): CostRow => ({ service, name: service, aud, kind, checkedAt });

  it("lists the dearest first, the name breaking a tie, with the whole-dollar month and year", () => {
    const view = costsView([row("fly", 860, "estimate", "2026-10-09T00:00:00Z"), row("hosting", 50.4, "actual", "2026-10-01T00:00:00Z"), row("claude", 1150, "actual", "2026-10-07T00:00:00Z"), row("backup", 50.4, "estimate", "2026-10-08T00:00:00Z")]);
    expect(view.rows.map((r) => [r.service, r.aud])).toEqual([
      ["claude", 1150],
      ["fly", 860],
      ["backup", 50.4],
      ["hosting", 50.4],
    ]);
    expect(view.monthAud).toBe(2111);
    expect(view.yearAud).toBe(25330);
    expect(view.fx).toEqual(COST_FX);
  });

  it("keeps the group Rivet set", () => {
    const stored: CostRow = { ...row("hosting", 300, "estimate", "2026-10-01T00:00:00Z"), group: "CI spend" };
    expect(costsView([stored]).rows).toEqual([stored]);
  });
});

describe("rivet cost", () => {
  it("sets, lists and drops rows; a set keeps the row's name, note and group unless given", async () => {
    expect(await cli(["cost", "set", "chatgpt", "--name", "ChatGPT 2× Pro", "--aud", "575", "--kind", "actual", "--note", "US$400", "--checked", "2026-10-07"])).toMatchObject({ code: 0, stdout: "chatgpt A$575 a month, actual, checked 2026-10-07\n" });
    expect((await cli(["cost", "set", "chatgpt", "--aud", "573.2", "--kind", "actual"])).code).toBe(0);
    expect((await costs()).rows).toEqual([{ service: "chatgpt", name: "ChatGPT 2× Pro", aud: 573.2, kind: "actual", note: "US$400", checkedAt: NOW }]);
    expect((await cli(["cost", "set", "chatgpt", "--aud", "573.2", "--kind", "actual", "--note", ""])).code).toBe(0);
    expect((await costs()).rows[0]?.note).toBeUndefined();
    // Rows of one group share a card on the page; a set without --group keeps it, --group "" takes it out.
    expect((await cli(["cost", "set", "chatgpt", "--aud", "573.2", "--kind", "actual", "--group", "AI tools"])).code).toBe(0);
    expect((await cli(["cost", "set", "chatgpt", "--aud", "573.2", "--kind", "actual"])).code).toBe(0);
    expect((await costs()).rows[0]?.group).toBe("AI tools");
    expect((await cli(["cost", "list"])).stdout).toContain("ChatGPT 2× Pro [AI tools]");
    expect((await cli(["cost", "set", "chatgpt", "--aud", "573.2", "--kind", "actual", "--group", ""])).code).toBe(0);
    expect((await costs()).rows[0]?.group).toBeUndefined();
    expect((await cli(["cost", "set", "chatgpt", "--aud", "1", "--kind", "actual", "--group", "x".repeat(61)])).code).toBe(2);

    const listed = await cli(["cost", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toBe("A$573 a month, A$6,878 a year\nchatgpt  A$573  actual  2026-10-09  ChatGPT 2× Pro\n");
    expect(await cli(["cost", "drop", "chatgpt"])).toMatchObject({ code: 0, stdout: "chatgpt dropped\n" });
    expect((await cli(["cost", "drop", "chatgpt"])).code).toBe(1);
  });

  it("keeps the name and note of a row a set leaves out, and only Rivet reads the row it set", async () => {
    expect((await cli(["cost", "set", "hosting", "--name", "Hosting runners", "--aud", "300", "--kind", "estimate", "--note", "From the invoice", "--checked", "2026-10-01"])).code).toBe(0);
    expect((await send("GET", "/api/costs/hosting", undefined, browser(cookie))).status).toBe(401);

    expect((await cli(["cost", "set", "hosting", "--aud", "320", "--kind", "actual"])).code).toBe(0);
    expect((await costs()).rows).toEqual([{ service: "hosting", name: "Hosting runners", aud: 320, kind: "actual", note: "From the invoice", checkedAt: NOW }]);
  });

  it("refuses a set when it cannot read the row it would keep the name and note of", async () => {
    let put = false;
    const env = { RIVET_BRIDGE_DEV: "1", RIVET_BOARD_TOKEN: BOARD_TOKEN, RIVET_URL: server.base, PATH: "" };
    const fetch = async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") put = true;
      return new Response(init.method === "GET" ? "{" : "{}");
    };
    let stderr = "";
    const code: number = await run(["cost", "set", "fly", "--aud", "900", "--kind", "actual"], { env, fetch, stdout: () => {}, stderr: (s: string) => void (stderr += s) });
    expect(code).toBe(1);
    expect(stderr).toContain("server did not return the row");
    expect(put).toBe(false);
  });

  it("refuses a set it cannot send", async () => {
    for (const argv of [
      ["cost", "set", "fly", "--kind", "estimate"],
      ["cost", "set", "fly", "--aud", "1,000", "--kind", "estimate"],
      ["cost", "set", "fly", "--aud", "10"],
      ["cost", "set", "Fly", "--aud", "10", "--kind", "estimate"],
      ["cost", "set", "fly", "--aud", "10", "--kind", "estimate", "--checked", "yesterday"],
      ["cost", "list", "fly"],
    ])
      expect((await cli(argv)).code, argv.join(" ")).toBe(2);
  });
});
