import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ALL_BEHAVIOURS, BehavioursStore, OWNER, type StoredBehaviour } from "../behaviours.js";
import { registerChats } from "../chats-report.js";
import { onHostedMachine } from "../hosted-name.js";
import { hasBearer, HttpError, json, readJson, requireBearer, requireSameOrigin } from "../httputil.js";
import { BEHAVIOURS, type Behaviour, type BehaviourRow, type BehavioursResponse, type RowReport, type SwitchDone, type SwitchState } from "../../shared/behaviours.js";
import { type Chats, CHATS_ID, chatsLine, type ChatsLineResponse, type ChatsReport } from "../../shared/chats.js";
import type { Router } from "./router.js";

// Settings › Behaviours: the list of what Rivet does by itself, each with its stored value. A hosted machine is
// its customer's, so it never sees the owner's private rows, even where the build carries them.

const SMALL_BODY_MAX = 16 * 1024;
const PREFIX = "/api/behaviours/";

interface SwitchBoard {
  state(id: string): SwitchState;
  report(id: string): RowReport;
  put(id: string, value: unknown): Promise<{ state: SwitchState; done: SwitchDone }>;
}

// A `switch` row's value is a file on the owner's Mac, and a `report` row's words the Mac's last report, which only the
// owner's version can reach; the public export leaves that module out, so it is read only when present and never
// imported by name.
const SWITCHES_FILE = new URL("../behaviour-switches.ts", import.meta.url);
const switchesModule = existsSync(fileURLToPath(SWITCHES_FILE)) ? ((await import(SWITCHES_FILE.href)) as { registerSwitches(router: Router): SwitchBoard }) : null;

function row(behaviour: Behaviour, stored: StoredBehaviour): BehaviourRow {
  const { knobs: _knobs, default: _default, chip, ...shown } = behaviour;
  if (behaviour.control === "endpoint") return { ...shown, value: null, chip: null, updatedAt: null };
  return { ...shown, value: stored.value, chip: chip?.(stored.value) ?? null, updatedAt: stored.updatedAt };
}

/** The Chats row's chip is the bridge's count against the stored cap, and its note the last pass. */
function chatsRow(shown: BehaviourRow, report: ChatsReport | null): BehaviourRow {
  const note = report ? `Last pass: ${report.closed.length} closed, ${report.kept.length} kept` : "Can't tell: no report from the Mac";
  return { ...shown, chip: chatsLine(report, (shown.value as Chats).cap), report: { note, detail: null } };
}

/** A switch row shows the file as reported, never a stored wish. */
function switchRow(behaviour: Behaviour, state: SwitchState): BehaviourRow {
  return { ...row(behaviour, { value: { on: state.state === "absent" }, updatedAt: null }), switch: state };
}

export function register(router: Router): void {
  const { config, requireSession, now } = router.deps;
  const store = new BehavioursStore(config.dataDir);
  router.onClose(() => store.close());
  const switches = switchesModule?.registerSwitches(router) ?? null;
  const chats = registerChats(router);
  const chatsBehaviour = BEHAVIOURS.find((behaviour) => behaviour.id === CHATS_ID)!;
  const liveRow = (behaviour: Behaviour, stored: StoredBehaviour): BehaviourRow =>
    behaviour.id === CHATS_ID ? chatsRow(row(behaviour, stored), chats.report()) : row(behaviour, stored);

  const visible = (): readonly Behaviour[] =>
    (onHostedMachine() ? ALL_BEHAVIOURS.filter((behaviour) => behaviour.scope !== "private") : ALL_BEHAVIOURS).filter((behaviour) => behaviour.control !== "report" || switches);
  const shown = (behaviour: Behaviour): BehaviourRow => {
    if (behaviour.control === "switch") return switchRow(behaviour, switches?.state(behaviour.id) ?? { state: "offline" });
    if (behaviour.control === "report") return { ...row(behaviour, { value: {}, updatedAt: null }), value: null, report: switches!.report(behaviour.id) };
    return liveRow(behaviour, store.get(OWNER, behaviour));
  };

  // The Mac's jobs read their switch and knobs with the board token; only a signed-in browser writes them.
  router.on("GET", "/api/behaviours", ({ request, response }) => {
    if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
    const body: BehavioursResponse = { behaviours: visible().map(shown) };
    json(response, 200, body);
  });

  // The bridge's read of the values it honours on the machine (the Limit autopilot's knobs, for one).
  router.on("GET", "/api/bridge/behaviours", ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const live = visible().filter((behaviour) => behaviour.control === "live");
    json(response, 200, { values: Object.fromEntries(live.map((behaviour) => [behaviour.id, store.get(OWNER, behaviour).value])) });
  });

  // Progress's one line: the same count the row's chip shows.
  router.on("GET", "/api/chats", ({ request, response }) => {
    requireSession(request);
    const fresh = chats.fresh();
    const body: ChatsLineResponse = { line: chatsLine(fresh?.report ?? null, (store.get(OWNER, chatsBehaviour).value as Chats).cap), leftMs: fresh?.leftMs ?? null };
    json(response, 200, body);
  });

  router.onPrefix("PUT", PREFIX, async ({ request, response, url }) => {
    requireSameOrigin(request, config.origin);
    requireSession(request);
    const id = url.pathname.slice(PREFIX.length);
    const behaviour = visible().find((entry) => entry.id === id);
    if (!behaviour) throw new HttpError(404, "no such behaviour");
    // Closed unless the row says it is a preference: what the agent does by itself goes on after "Sign out desktop apps".
    if (!behaviour.preference) router.deps.requirePasskeySession(request, "change what your agent does by itself");
    const value = await readJson(request, SMALL_BODY_MAX);
    if (behaviour.control === "switch" && switches) {
      const { state, done } = await switches.put(behaviour.id, value);
      json(response, 200, { ...switchRow(behaviour, state), done });
      return;
    }
    if (behaviour.control !== "live") throw new HttpError(409, "this behaviour is not set here");
    const saved = store.put(OWNER, behaviour, value, now());
    if (!saved) throw new HttpError(400, "invalid behaviour value");
    // No log line: the server's logger is error-only and the error readers would count every tap. The row's
    // updatedAt is the write's record, as for the other /api/settings/* saves.
    json(response, 200, liveRow(behaviour, saved));
  });
}
