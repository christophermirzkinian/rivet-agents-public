import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createHomeFamily } from "../lib/actions/home.mjs";
import { collectHome, haBaseUrl, HA_TOKEN_SERVICE, homeFile, readHaToken, readHomeSettings } from "../lib/ops/home.mjs";

const NOW = new Date("2026-10-25T02:00:00.000Z");
const HA = "http://ha.test";
const HA_TOKEN = "h".repeat(40);
const ID = ["6f1c1a2e", "1b7a", "4c1e", "9a43", "0d6f5f0f6b11"].join("-");
const BRIDGE = "bridge-token-for-tests";

const SETTINGS = {
  tiles: [
    { label: "Reading one", entity_id: "sensor.example_reading", unit: "units" },
    { label: "Reading two", entity_id: "sensor.example_other" },
    { label: "Gone quiet", entity_id: "sensor.example_quiet" },
    { label: "Not there", entity_id: "sensor.example_missing" },
  ],
  buttons: [
    { label: "Lamp on", service: "light.turn_on", entity_id: "light.example_lamp", data: { brightness: 120 } },
    { label: "Fan off", service: "switch.turn_off", entity_id: "switch.example_fan" },
  ],
};
const STATES = [
  { entity_id: "sensor.example_reading", state: "21.5", attributes: { unit_of_measurement: "ignored" } },
  { entity_id: "sensor.example_other", state: "42", attributes: { unit_of_measurement: "ppm" } },
  { entity_id: "sensor.example_quiet", state: "unavailable", attributes: {} },
  { entity_id: "sensor.example_private", state: "never sent", attributes: { friendly_name: "Private" } },
];

let dir;
test.beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "home-test-"));
});
test.afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const settings = (value = SETTINGS) => {
  const file = path.join(dir, "home.json");
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch answering by "METHOD path"; every call is kept on `.calls`. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method ?? "GET"} ${pathname}${search}`;
    calls.push({ key, url: String(url), init });
    const route = routes[key];
    if (!route) return json({}, 404);
    if (typeof route === "function") return route(init);
    return new Response(await route.clone().text(), { status: route.status, headers: route.headers });
  };
  fetch.calls = calls;
  return fetch;
}

/** A Keychain holding Home Assistant's token under its own service; `.reads` counts the reads. */
function fakeKeychain(token = HA_TOKEN) {
  const exec = async (_bin, args) => {
    exec.reads += 1;
    if (args[args.indexOf("-s") + 1] !== HA_TOKEN_SERVICE) throw new Error("wrong service");
    if (token === null) throw new Error("not found");
    return { stdout: `${token}\n` };
  };
  exec.reads = 0;
  return exec;
}

function context(fetch, exec = fakeKeychain()) {
  const logs = [];
  return { logs, ctx: { deps: { fetch, exec, origin: "http://rivet.test", token: BRIDGE, log: (event, fields) => logs.push({ event, ...fields }) } } };
}
const ROUTES = {
  "GET /api/states": json(STATES),
  "GET /api/states/light.example_lamp": json({ entity_id: "light.example_lamp", state: "off", attributes: {} }),
  "GET /api/states/switch.example_fan": json({ entity_id: "switch.example_fan", state: "on", attributes: {} }),
  "PUT /api/bridge/home": json({ ok: true }),
  "POST /api/bridge/home/control-ack": json({ ok: true }),
};
const acks = (fetch) => fetch.calls.filter((one) => one.key === "POST /api/bridge/home/control-ack").map((one) => JSON.parse(one.init.body));
const haCalls = (fetch) => fetch.calls.filter((one) => one.url.startsWith(HA));
const until = (ms = 13_000) => Date.now() + ms;

test("the example settings file reads whole", async () => {
  const example = fileURLToPath(new URL("../../home-automation/home.example.json", import.meta.url));
  const settings = await readHomeSettings(example);
  assert.equal(settings.skipped, 0);
  assert.ok(settings.tiles.length > 0 && settings.buttons.length > 0);
});

test("the settings live in the user's own folder and nothing has a default address", () => {
  assert.equal(homeFile(), path.join(os.homedir(), ".rivet-agents", "home.json"));
  assert.equal(haBaseUrl(""), null);
  assert.equal(haBaseUrl("not a url"), null);
  assert.equal(haBaseUrl("ftp://ha.test"), null);
  assert.equal(haBaseUrl("http://someone:secret@ha.test"), null);
  assert.equal(haBaseUrl("http://ha.test:8123/"), "http://ha.test:8123");
});

test("readHomeSettings reads tiles and buttons, and no file is empty lists", async () => {
  assert.deepEqual(await readHomeSettings(path.join(dir, "none.json")), { tiles: [], buttons: [], skipped: 0 });
  const read = await readHomeSettings(settings());
  assert.deepEqual(read.tiles[0], { label: "Reading one", entity_id: "sensor.example_reading", unit: "units" });
  assert.equal(read.tiles[1].unit, null);
  assert.deepEqual(read.buttons.map((one) => one.label), ["Lamp on", "Fan off"]);
  assert.match(read.buttons[0].id, /^[0-9a-f]{16}$/);
  assert.equal(read.skipped, 0);
});

test("a broken file is empty lists, counted", async () => {
  assert.deepEqual(await readHomeSettings(settings("{ not json")), { tiles: [], buttons: [], skipped: 1 });
  assert.deepEqual(await readHomeSettings(settings(`{"tiles":[],"pad":"${"x".repeat(70_000)}"}`)), { tiles: [], buttons: [], skipped: 1 });
});

test("rows that do not fit are left out: bad ids, a bad service, data that would aim the call elsewhere", async () => {
  const read = await readHomeSettings(
    settings({
      tiles: [{ label: "", entity_id: "sensor.a" }, { label: "No id" }, { label: "Bad id", entity_id: "Sensor A" }, { label: "Bad unit", entity_id: "sensor.a", unit: 3 }, null, { label: "Kept", entity_id: "sensor.a" }],
      buttons: [
        { label: "No service", entity_id: "light.a" },
        { label: "Path trick", service: "light/../x.turn_on", entity_id: "light.a" },
        { label: "No entity", service: "light.turn_on" },
        { label: "Aimed", service: "light.turn_on", entity_id: "light.a", data: { entity_id: "light.b" } },
        { label: "By area", service: "light.turn_on", entity_id: "light.a", data: { area_id: "everywhere" } },
        { label: "List data", service: "light.turn_on", entity_id: "light.a", data: [] },
        { label: "Big data", service: "light.turn_on", entity_id: "light.a", data: { pad: "x".repeat(3000) } },
        { label: "Kept", service: "light.turn_on", entity_id: "light.a" },
        { label: "Kept", service: "light.turn_on", entity_id: "light.a" },
      ],
    }),
  );
  assert.deepEqual(read.tiles.map((one) => one.label), ["Kept"]);
  assert.deepEqual(read.buttons.map((one) => one.label), ["Kept"]);
  assert.equal(read.skipped, 13);
});

test("the file is cut to what the server takes", async () => {
  const read = await readHomeSettings(
    settings({
      tiles: Array.from({ length: 30 }, (_, i) => ({ label: `${"t".repeat(50)}${i}`, entity_id: `sensor.a${i}`, unit: "u".repeat(20) })),
      buttons: Array.from({ length: 20 }, (_, i) => ({ label: `Button ${i}`, service: "light.turn_on", entity_id: `light.a${i}` })),
    }),
  );
  assert.equal(read.tiles.length, 24);
  assert.equal(read.buttons.length, 12);
  assert.equal(read.tiles[0].label.length, 40);
  assert.equal(read.tiles[0].unit.length, 12);
});

test("a button's id moves with its row, so a stale page's press finds nothing", async () => {
  const before = (await readHomeSettings(settings())).buttons[0].id;
  assert.equal((await readHomeSettings(settings())).buttons[0].id, before);
  const moved = structuredClone(SETTINGS);
  moved.buttons[0].entity_id = "light.example_other";
  assert.notEqual((await readHomeSettings(settings(moved))).buttons[0].id, before);
});

test("readHaToken takes the setting first, then the Keychain, and refuses a malformed token", async () => {
  const exec = fakeKeychain();
  assert.equal(await readHaToken(exec, 1000, { RIVET_HA_TOKEN: "e".repeat(40) }), "e".repeat(40));
  assert.equal(exec.reads, 0);
  assert.equal(await readHaToken(exec, 1000, {}), HA_TOKEN);
  assert.equal(exec.reads, 1);
  assert.equal(await readHaToken(exec, 1000, { RIVET_HA_TOKEN: "short" }), null);
  assert.equal(await readHaToken(fakeKeychain(null), 1000, {}), null);
  assert.equal(await readHaToken(fakeKeychain("short"), 1000, {}), null);
});

test("collectHome reads each tile and the button labels, and sends only those", async () => {
  const fetch = fakeFetch(ROUTES);
  const snapshot = await collectHome({ fetch, exec: fakeKeychain(), haUrl: HA, file: settings(), now: () => NOW, cache: { token: null } });
  assert.equal(snapshot.at, NOW.toISOString());
  assert.equal(snapshot.haReachable, true);
  assert.deepEqual(snapshot.tiles, [
    { label: "Reading one", value: "21.5", unit: "units" },
    { label: "Reading two", value: "42", unit: "ppm" },
    { label: "Gone quiet", value: null, unit: null },
    { label: "Not there", value: null, unit: null },
  ]);
  assert.deepEqual(snapshot.buttons.map((one) => one.label), ["Lamp on", "Fan off"]);
  assert.deepEqual(Object.keys(snapshot.buttons[0]).sort(), ["id", "label"]);
  const sent = JSON.stringify(snapshot);
  for (const secret of ["sensor.example", "light.", "turn_on", "brightness", "never sent", HA_TOKEN]) assert.equal(sent.includes(secret), false, secret);
});

test("collectHome cuts a long state, and says only that Home Assistant is down when it is", async () => {
  const long = fakeFetch({ "GET /api/states": json([{ entity_id: "sensor.example_reading", state: "x".repeat(300), attributes: {} }]) });
  const read = await collectHome({ fetch: long, exec: fakeKeychain(), haUrl: HA, file: settings(), cache: { token: null } });
  assert.equal(read.tiles[0].value.length, 64);
  for (const answer of [json({}, 500), json({ not: "a list" })]) {
    const fetch = fakeFetch({ "GET /api/states": answer });
    assert.deepEqual(await collectHome({ fetch, exec: fakeKeychain(), haUrl: HA, file: settings(), now: () => NOW, cache: { token: null } }), { at: NOW.toISOString(), haReachable: false });
  }
  const noToken = await collectHome({ fetch: fakeFetch(ROUTES), exec: fakeKeychain(null), haUrl: HA, file: settings(), now: () => NOW, cache: { token: null } });
  assert.deepEqual(noToken, { at: NOW.toISOString(), haReachable: false });
});

test("collectHome with an empty file still reports Home Assistant reachable, and logs rows it left out", async () => {
  const logged = [];
  const empty = await collectHome({ fetch: fakeFetch(ROUTES), exec: fakeKeychain(), haUrl: HA, file: path.join(dir, "none.json"), cache: { token: null }, log: (event) => logged.push(event) });
  assert.equal(empty.haReachable, true);
  assert.deepEqual([empty.tiles, empty.buttons, logged], [[], [], []]);
  await collectHome({ fetch: fakeFetch(ROUTES), exec: fakeKeychain(), haUrl: HA, file: settings("{ not json"), cache: { token: null }, log: (event) => logged.push(event) });
  assert.deepEqual(logged, ["home-file-rows-skipped"]);
});

test("collectHome reads the token again after a 401", async () => {
  let first = true;
  const fetch = fakeFetch({
    "GET /api/states": (init) => {
      if (first) {
        first = false;
        return json({}, 401);
      }
      assert.equal(init.headers.authorization, `Bearer ${HA_TOKEN}`);
      return json(STATES);
    },
  });
  const exec = fakeKeychain();
  const snapshot = await collectHome({ fetch, exec, haUrl: HA, file: settings(), cache: { token: "stale".repeat(8) } });
  assert.equal(snapshot.haReachable, true);
  assert.equal(exec.reads, 1);
});

test("a press calls the file's service for its entity, then sends a fresh reading before the ack", async () => {
  const file = settings();
  const { buttons } = await readHomeSettings(file);
  const fetch = fakeFetch({ ...ROUTES, "POST /api/services/light/turn_on": json([]) });
  const { ctx, logs } = context(fetch);
  const family = createHomeFamily({ haUrl: HA, file });
  assert.equal(await family.handle("home-control", { id: ID, button: buttons[0].id, until: until() }, ctx), "delivered");
  const call = fetch.calls.find((one) => one.key === "POST /api/services/light/turn_on");
  assert.deepEqual(JSON.parse(call.init.body), { brightness: 120, entity_id: "light.example_lamp" });
  assert.equal(call.init.headers.authorization, `Bearer ${HA_TOKEN}`);
  assert.equal(call.init.redirect, "error");
  assert.deepEqual(fetch.calls.map((one) => one.key), ["GET /api/states/light.example_lamp", "POST /api/services/light/turn_on", "GET /api/states", "PUT /api/bridge/home", "POST /api/bridge/home/control-ack"]);
  assert.deepEqual(acks(fetch), [{ id: ID, ok: true }]);
  assert.deepEqual(logs, [{ event: "home-control-done", id: ID }]);
});

test("the token goes to Home Assistant alone, never to the server", async () => {
  const file = settings();
  const { buttons } = await readHomeSettings(file);
  const fetch = fakeFetch({ ...ROUTES, "POST /api/services/switch/turn_off": json([]) });
  await createHomeFamily({ haUrl: HA, file }).handle("home-control", { id: ID, button: buttons[1].id, until: until() }, context(fetch).ctx);
  const toServer = fetch.calls.filter((call) => !call.url.startsWith(HA));
  assert.equal(toServer.length, 2);
  for (const one of toServer) {
    assert.equal(JSON.stringify([one.init.headers, one.init.body]).includes(HA_TOKEN), false);
    assert.equal(one.init.headers.authorization, `Bearer ${BRIDGE}`);
  }
});

test("an id not in the file is refused and never reaches Home Assistant", async () => {
  const family = createHomeFamily({ haUrl: HA, file: settings() });
  for (const button of ["0123456789abcdef", "light.turn_on", undefined, 7]) {
    const fetch = fakeFetch(ROUTES);
    assert.equal(await family.handle("home-control", { id: ID, button, until: until() }, context(fetch).ctx), "dropped");
    assert.deepEqual(acks(fetch), [{ id: ID, ok: false, error: "unknown_button" }]);
    assert.deepEqual(haCalls(fetch), []);
  }
});

test("a button taken out of the file since the page drew it is refused", async () => {
  const file = settings();
  const { buttons } = await readHomeSettings(file);
  settings({ tiles: [], buttons: [] });
  const fetch = fakeFetch(ROUTES);
  await createHomeFamily({ haUrl: HA, file }).handle("home-control", { id: ID, button: buttons[0].id, until: until() }, context(fetch).ctx);
  assert.deepEqual(acks(fetch), [{ id: ID, ok: false, error: "unknown_button" }]);
  assert.deepEqual(haCalls(fetch), []);
});

test("with no address set a press is not_set_up and nothing is called", async () => {
  const file = settings();
  const saved = process.env.RIVET_HA_URL;
  delete process.env.RIVET_HA_URL;
  try {
    const { buttons } = await readHomeSettings(file);
    const fetch = fakeFetch(ROUTES);
    await createHomeFamily({ file }).handle("home-control", { id: ID, button: buttons[0].id, until: until() }, context(fetch).ctx);
    assert.deepEqual(acks(fetch), [{ id: ID, ok: false, error: "not_set_up" }]);
    assert.equal(fetch.calls.length, 1);
  } finally {
    if (saved !== undefined) process.env.RIVET_HA_URL = saved;
  }
});

test("no token is not_set_up, and a Home Assistant failure is home_assistant with no fresh reading", async () => {
  const file = settings();
  const { buttons } = await readHomeSettings(file);
  const family = createHomeFamily({ haUrl: HA, file });
  const none = fakeFetch(ROUTES);
  await family.handle("home-control", { id: ID, button: buttons[0].id, until: until() }, context(none, fakeKeychain(null)).ctx);
  assert.deepEqual(acks(none), [{ id: ID, ok: false, error: "not_set_up" }]);
  assert.deepEqual(haCalls(none), []);
  const fetch = fakeFetch({ ...ROUTES, "POST /api/services/light/turn_on": json({}, 500) });
  await family.handle("home-control", { id: ID, button: buttons[0].id, until: until() }, context(fetch).ctx);
  assert.deepEqual(acks(fetch), [{ id: ID, ok: false, error: "home_assistant" }]);
  assert.equal(fetch.calls.some((one) => one.key === "PUT /api/bridge/home"), false);
});

test("a press on an entity Home Assistant reports unavailable is refused as offline, and its service is never called", async () => {
  const file = settings();
  const { buttons } = await readHomeSettings(file);
  const family = createHomeFamily({ haUrl: HA, file });
  const lamp = (state) => json({ entity_id: "light.example_lamp", state, attributes: {} });
  const fetch = fakeFetch({ ...ROUTES, "GET /api/states/light.example_lamp": lamp("unavailable"), "POST /api/services/light/turn_on": json([]) });
  const { ctx, logs } = context(fetch);
  assert.equal(await family.handle("home-control", { id: ID, button: buttons[0].id, until: until() }, ctx), "dropped");
  assert.deepEqual(acks(fetch), [{ id: ID, ok: false, error: "offline" }]);
  assert.equal(fetch.calls.some((one) => one.key.startsWith("POST /api/services/")), false);
  assert.equal(fetch.calls.some((one) => one.key === "PUT /api/bridge/home"), false);
  assert.deepEqual(logs, [{ event: "home-control-failed", id: ID, error: "offline" }]);
  // "unknown" is a real state for a scene or a script that has never run, and a failed state read stops nothing.
  for (const answer of [lamp("unknown"), json({}, 500)]) {
    const goes = fakeFetch({ ...ROUTES, "GET /api/states/light.example_lamp": answer, "POST /api/services/light/turn_on": json([]) });
    await family.handle("home-control", { id: ID, button: buttons[0].id, until: until() }, context(goes).ctx);
    assert.deepEqual(acks(goes), [{ id: ID, ok: true }]);
  }
});

test("a press the server has nearly stopped waiting for is not run, and a bad event id is dropped unanswered", async () => {
  const file = settings();
  const { buttons } = await readHomeSettings(file);
  const family = createHomeFamily({ haUrl: HA, file });
  const late = fakeFetch(ROUTES);
  const { ctx, logs } = context(late);
  assert.equal(await family.handle("home-control", { id: ID, button: buttons[0].id, until: until(500) }, ctx), "dropped");
  assert.deepEqual(late.calls, []);
  assert.deepEqual(logs, [{ event: "drop", id: ID, reason: "home-control-late" }]);
  const bad = fakeFetch(ROUTES);
  assert.equal(await family.handle("home-control", { id: "nope", button: buttons[0].id }, context(bad).ctx), "dropped");
  assert.deepEqual(bad.calls, []);
});

test("an unreachable reading never holds the ack, and with little time left the reading is skipped", async () => {
  const file = settings();
  const { buttons } = await readHomeSettings(file);
  const family = createHomeFamily({ haUrl: HA, file });
  const refused = () => {
    throw new Error("down");
  };
  const down = fakeFetch({ ...ROUTES, "POST /api/services/light/turn_on": json([]), "GET /api/states": json({}, 500), "PUT /api/bridge/home": refused });
  await family.handle("home-control", { id: ID, button: buttons[0].id, until: until() }, context(down).ctx);
  assert.deepEqual(acks(down), [{ id: ID, ok: true }]);
  const short = fakeFetch({ ...ROUTES, "POST /api/services/light/turn_on": json([]) });
  await family.handle("home-control", { id: ID, button: buttons[0].id, until: until(4_000) }, context(short).ctx);
  assert.equal(short.calls.some((one) => one.key === "GET /api/states"), false);
  assert.deepEqual(acks(short), [{ id: ID, ok: true }]);
});

test("a stalled token read for the fresh reading never holds the ack past its deadline", async () => {
  const file = settings();
  const { buttons } = await readHomeSettings(file);
  let reads = 0;
  const exec = async () => {
    reads += 1;
    if (reads > 1) await new Promise(() => {});
    return { stdout: `${HA_TOKEN}\n` };
  };
  const fetch = fakeFetch({ ...ROUTES, "POST /api/services/light/turn_on": json([]) });
  const started = Date.now();
  await createHomeFamily({ haUrl: HA, file }).handle("home-control", { id: ID, button: buttons[0].id, until: until() }, context(fetch, exec).ctx);
  assert.ok(Date.now() - started < 4_000);
  assert.deepEqual(acks(fetch), [{ id: ID, ok: true }]);
});

test("home-control is the family's only event", () => {
  assert.deepEqual([...createHomeFamily().events], ["home-control"]);
});
