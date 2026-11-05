import { afterEach, beforeEach, expect, it } from "vitest";
import { join } from "node:path";
import { OpsStore } from "../src/server/ops/store.js";
import type { Briefing } from "../src/shared/ops.js";
import { browser, startServer, type TestServer } from "./helpers.js";

let server: TestServer;
const past: Briefing = {
  id: "2026-09-28-morning", slot: "morning", day: "2026-09-28",
  at: "2026-09-27T21:30:00.000Z", composedAt: "2026-09-27T21:31:00.000Z",
  since: "2026-09-27T08:00:00.000Z", headline: "Historical marker",
  items: [{ key: "needs", tone: "warn", title: "Historical needs", lines: ["First", "Second", "Third"] }],
  shippedSeen: [], seen: [], notes: [{ text: "Past note", at: "2026-09-27T22:00:00.000Z" }],
};
beforeEach(async () => {
  server = await startServer();
  const store = new OpsStore(join(server.webRoot, "..", "data"));
  store.addBriefing(past);
  store.addBriefing({ ...past, id: "2026-09-29-morning", day: "2026-09-29", composedAt: "2026-09-28T21:31:00.000Z", headline: "Latest marker" });
  store.close();
});
afterEach(async () => { await server.close(); });

it("search targets the matching snapshot and lookup returns it instead of latest", async () => {
  const headers = browser(server.cookie());
  const search = await fetch(`${server.base}/api/ops/search?q=Historical`, { headers });
  const { results } = await search.json();
  expect(results.find((item: { key: string }) => item.key === `briefing:${past.id}`).open).toEqual({ type: "briefing", id: past.id });
  const selected = await fetch(`${server.base}/api/briefing?id=${past.id}`, { headers });
  expect(await selected.json()).toEqual({ briefing: past });
  const latest = await fetch(`${server.base}/api/briefing`, { headers });
  expect((await latest.json()).briefing.headline).toBe("Latest marker");
  const missing = await fetch(`${server.base}/api/briefing?id=missing`, { headers });
  expect(await missing.json()).toEqual({ briefing: null });
});

it("keeps the existing session requirement for ID lookups", async () => {
  const response = await fetch(`${server.base}/api/briefing?id=${past.id}`);
  expect(response.status).toBe(401);
});
