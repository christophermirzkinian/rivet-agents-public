import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIND_MAX_BYTES, mindMarksGone, type MindNode, type MindPut, type MindPutResponse, type MindResponse } from "../src/shared/mind.js";
import { bearer, BOARD_TOKEN, BRIDGE_TOKEN, oversizedStatus, startServer, type TestServer } from "./helpers.js";

const NOW = new Date("2026-11-03T01:00:00.000Z");
const node = (id: string, extra: Partial<MindNode> = {}): MindNode => ({ id, kind: "memory", type: "feedback", label: id, desc: "", body: "", written: null, ...extra });
const GRAPH: MindPut = {
  built: NOW.getTime(),
  loaded: ["index"],
  nodes: [
    node("index", { kind: "context", type: "context", label: "Index", desc: "Every memory", body: "# Index" }),
    node("water-before-noon", { label: "Water before noon", desc: "morning is best", body: "Why: the leaves dry by evening.", written: NOW.getTime() - 3_600_000 }),
    node("note:seed-order", { kind: "note", type: "note", label: "Sam's seed order" }),
  ],
  links: [
    { source: "index", target: "water-before-noon", kind: "loaded" },
    { source: "index", target: "note:seed-order", kind: "wikilink" },
  ],
};
// Built here so the secret scan does not read a made-up key as one.
const GH = ["gh", "p_"].join("");
const put = (base: string, body: unknown, token = BRIDGE_TOKEN) =>
  fetch(`${base}/api/bridge/mind`, { method: "PUT", headers: bearer(token), body: typeof body === "string" ? body : JSON.stringify(body) });

describe("PUT /api/bridge/mind and GET /api/mind", () => {
  let server: TestServer;
  const get = (path: string) => fetch(`${server.base}${path}`, { headers: { cookie: server.cookie() } });
  beforeEach(async () => {
    server = await startServer({}, { now: () => NOW });
  });
  afterEach(async () => {
    await server.close();
  });

  it("takes a graph only with the bridge token, and the app reads it only with a session", async () => {
    expect((await fetch(`${server.base}/api/bridge/mind`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(GRAPH) })).status).toBe(401);
    expect((await put(server.base, GRAPH, BOARD_TOKEN)).status).toBe(401);
    expect((await put(server.base, GRAPH, "d".repeat(64))).status).toBe(401);
    for (const path of ["/api/mind", "/api/mind/node?id=index", "/api/mind/search?q=noon"]) {
      expect((await fetch(`${server.base}${path}`)).status).toBe(401);
      expect((await fetch(`${server.base}${path}`, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(401);
    }

    const taken = await put(server.base, GRAPH);
    expect(taken.status).toBe(200);
    expect((await taken.json()) as MindPutResponse).toEqual({ ok: true, nodes: 3, links: 2 });
  });

  it("says there is no map before the first, and the dots come without their words", async () => {
    expect(await (await get("/api/mind")).json()).toEqual({ graph: null, receivedAt: null });
    await put(server.base, GRAPH);
    const read = (await (await get("/api/mind")).json()) as MindResponse;
    expect(read.receivedAt).toBe(NOW.toISOString());
    expect(read.graph?.loaded).toEqual(["index"]);
    expect(read.graph?.links).toEqual(GRAPH.links);
    expect(read.graph?.nodes.map((n) => Object.keys(n).sort())).toEqual([
      ["id", "kind", "label", "type", "written"],
      ["id", "kind", "label", "type", "written"],
      ["id", "kind", "label", "type", "written"],
    ]);
  });

  it("gives one node's words on a tap, and finds words in any text", async () => {
    await put(server.base, GRAPH);
    expect(await (await get("/api/mind/node?id=water-before-noon")).json()).toEqual({ id: "water-before-noon", desc: "morning is best", body: "Why: the leaves dry by evening." });
    expect((await get("/api/mind/node?id=nope.md")).status).toBe(404);
    expect(await (await get("/api/mind/search?q=LEAVES%20dry")).json()).toEqual({ ids: ["water-before-noon"] });
    expect(await (await get("/api/mind/search?q=sam's")).json()).toEqual({ ids: ["note:seed-order"] });
    expect(await (await get("/api/mind/search?q=100%25_")).json()).toEqual({ ids: [] });
    expect(await (await get("/api/mind/search?q=")).json()).toEqual({ ids: [] });
  });

  it("reads each node's words whole: a scheme on one line and its secret on the next are not kept", async () => {
    await put(server.base, { ...GRAPH, nodes: [node("auth.md", { body: "Authorization: Basic\ndGVzdDpodW50ZXIyc2VjcmV0\nthen it worked" })], links: [], loaded: [] });
    const said = (await (await get("/api/mind/node?id=auth.md")).json()) as { body: string };
    expect(said.body).not.toContain("dGVzdDpodW50ZXIyc2VjcmV0");
    expect(said.body).toContain("[redacted]");
  });

  it.each([
    ["a scheme in the description and its secret in the body", "Authorization: Basic", "dGVzdDph\nthen it worked"],
    ["a secret in code marks under its scheme", "", "Basic\n`dGVzdDph`"],
    ["a secret as a link's words under its scheme", "", "Basic\n[dGVzdDph](x)"],
    ["a secret in a link in a link", "", "Basic [[dGVzdDph](x)](y) done"],
    ["a token split by bold marks", "", `${GH}Ab3dEf4g**Hj5kLm6n**Pq7rSt8u**Vw9xYz0A**Bc1D`],
    ["a link target that names the command", "[client](mysql)", "-p dGVzdDph"],
    ["a command only in a link target and a flag only plain once shown", "[client](mysql)", "-**p** dGVzdDph"],
    ["both on one line", "", "[client](mysql) -**p** dGVzdDph"],
    ["a scheme that swallows the marked command", "Basic", "mysqladm**in** -p dGVzdDph"],
    ["marks left between a scheme and its secret", "", "Basic** dGVzdDph"],
    ["marks before a flag", "", "[client](mysql) -**p dGVzdDph"],
    ["marks in a link target", "", "[client](my**sql) -**p** dGVzdDph"],
    ["marks inside marks in a secret", "", "[client](Bearer) dGVz*``*dDph"],
    ["marks inside nested marks", "", "[x](Bearer) dGVz*`**`*dDph"],
    ["a scheme a later step joins to the word before it", "", "[x](a**Basic) dGVzdDph"],
    ["a scheme joined away and a token split by marks on one line", "", "[x](a**Basic) dGVz*``*dDph"],
    ["a scheme joined away in the description, its secret in the body", "[x](a**Basic)", "dGVzdDph"],
    ["a scheme joined away over a line from its marked secret", "", "[x](a**Basic)\n*``*dGVzdDph"],
    ["a scheme the sheet passes on its way", "", "a*[z](z)*Basic dGVzdDph"],
    ["a scheme in a hidden target before a shown secret", "[x](Basic)", "dGVzdDph"],
  ])("reads the words as the sheet shows them: %s", async (_why, desc, body) => {
    await put(server.base, { ...GRAPH, nodes: [node("auth.md", { desc, body })], links: [], loaded: [] });
    const said = (await (await get("/api/mind/node?id=auth.md")).json()) as { desc: string; body: string };
    expect(`${said.desc}\n${said.body}`).not.toContain("dGVzdDph");
    expect(mindMarksGone(said.desc)).toBe(said.desc);
    expect(mindMarksGone(said.body)).toBe(said.body);
  });

  it("keeps what the sheet shows: no marks, each field its own lines", async () => {
    const { redactNode } = await import("../src/server/routes/mind.js");
    expect(redactNode("a **bold** one", "kept [[link]] line")).toEqual({ desc: "a bold one", body: "kept link line" });
    const cutKey = `${GH}Ab3dEf4gHj5k\nLm6nPq7rSt8uVw9xYz0ABc1D`;
    expect(redactNode("a token cut", cutKey)).toEqual({ desc: "[redacted]", body: "[redacted]\n[redacted]" });
    expect(redactNode("", "AKIAABCD\nEFGHIJKLMNOP").body).toBe("[redacted]\n[redacted]");
    expect(redactNode("", `${GH}abcdefghijklmnopqr\nstuvwxyzabcdefghij`).body).toBe("[redacted]\n[redacted]");
    expect(redactNode("", `${GH}${"A".repeat(18)}\n${"A".repeat(18)}`).body).toBe("[redacted]\n[redacted]");
    expect(redactNode("ABCDEFABCDEFABCD", "abcdefabcdefabcd")).toEqual({ desc: "[redacted]", body: "[redacted]" });
    const started = Date.now();
    redactNode("blank run", `top\n${"\n".repeat(6000)}bottom`);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(redactNode("a", "line\nanother")).toEqual({ desc: "a", body: "line\nanother" });
    const split = redactNode("[D](x\ny)", "Tail");
    expect(split).toEqual({ desc: "[D](x\ny)", body: "Tail" });
  });

  it("cuts a name the map would show with a secret in it", async () => {
    await put(server.base, { ...GRAPH, nodes: [node("auth.md", { label: "Basic dGVzdDph" })], links: [], loaded: [] });
    const read = (await (await get("/api/mind")).json()) as MindResponse;
    expect(JSON.stringify(read)).not.toContain("dGVzdDph");
  });

  it("keeps an empty description after an empty screen was read", async () => {
    const { redactBlock, redactScreen } = await import("../src/server/redact.js");
    redactScreen([]);
    expect(redactBlock("")).toBe("");
    expect((await put(server.base, GRAPH)).status).toBe(200);
  });

  it("keeps only the latest graph", async () => {
    await put(server.base, GRAPH);
    await put(server.base, { ...GRAPH, loaded: [], nodes: [node("only.md")], links: [] });
    const read = (await (await get("/api/mind")).json()) as MindResponse;
    expect(read.graph?.nodes.map((n) => n.id)).toEqual(["only.md"]);
    expect((await get("/api/mind/node?id=water-before-noon")).status).toBe(404);
    expect(await (await get("/api/mind/search?q=noon")).json()).toEqual({ ids: [] });
  });

  it("gzips the graph for a reader that takes it", async () => {
    await put(server.base, GRAPH);
    const { request } = await import("node:http");
    const encoding = await new Promise<unknown>((resolve, reject) => {
      const req = request(`${server.base}/api/mind`, { headers: { cookie: server.cookie(), "accept-encoding": "gzip" } }, (res) => {
        res.resume();
        resolve(res.headers["content-encoding"]);
      });
      req.on("error", reject);
      req.end();
    });
    expect(encoding).toBe("gzip");
  });

  it.each([
    ["a key the graph does not have", { ...GRAPH, extra: 1 }],
    ["a node with a key it does not have", { ...GRAPH, nodes: [...GRAPH.nodes, { ...node("x.md"), colour: "red" }] }],
    ["a kind the page does not draw", { ...GRAPH, nodes: [...GRAPH.nodes, node("x.md", { kind: "planet" as never })] }],
    ["a node with no name", { ...GRAPH, nodes: [...GRAPH.nodes, node("x.md", { label: "" })] }],
    ["a name over 120 characters", { ...GRAPH, nodes: [...GRAPH.nodes, node("x.md", { label: "x".repeat(121) })] }],
    ["an id that is a path out", { ...GRAPH, nodes: [...GRAPH.nodes, node("../etc/passwd")] }],
    ["a node twice", { ...GRAPH, nodes: [...GRAPH.nodes, node("water-before-noon")] }],
    ["a link to no node", { ...GRAPH, links: [...GRAPH.links, { source: "index", target: "gone.md", kind: "hub" }] }],
    ["a loaded id with no node", { ...GRAPH, loaded: ["gone.md"] }],
    ["a time that is a word", { ...GRAPH, nodes: [...GRAPH.nodes, node("x.md", { written: "today" as never })] }],
    ["a list that is not one", { ...GRAPH, links: "none" }],
  ])("refuses %s and keeps the graph it had", async (_why, body) => {
    await put(server.base, GRAPH);
    expect((await put(server.base, body)).status).toBe(400);
    expect(((await (await get("/api/mind")).json()) as MindResponse).graph?.nodes).toHaveLength(3);
  });

  it("refuses a body that is not JSON, and one over its size", async () => {
    expect((await put(server.base, "{not json")).status).toBe(400);
    expect(await oversizedStatus(put(server.base, { ...GRAPH, pad: "x".repeat(MIND_MAX_BYTES) }))).toBe(413);
    expect(await (await get("/api/mind")).json()).toEqual({ graph: null, receivedAt: null });
  });
});
