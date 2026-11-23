import { randomUUID } from "node:crypto";

import { askCreateSchema, isFinished, MAX_ASKS } from "../../shared/asks.js";
import type { AuditEntry, ChatMessage } from "../../shared/command.js";
import { designsJob, designsLine, designsRequestSchema, designsWords, THREE_DESIGNS_ID, type Designs, type DesignsJob } from "../../shared/designs.js";
import { APP_NAME } from "../../shared/names.js";
import { ALL_BEHAVIOURS, BehavioursStore, OWNER } from "../behaviours.js";
import type { CommandStore } from "../commandstore.js";
import { openBoard } from "../http.js";
import { HttpError, json, readJson, requireSameOrigin } from "../httputil.js";
import { ensureAsk, nextAskId } from "./asks.js";
import { appLookPickOf } from "./models.js";
import type { Router } from "./router.js";

// The "3 designs" button (shared/designs.ts): one ask per card or screen and a line in the owner's chat to the monitor, as
// Backlog's Start work makes. Nothing goes to a group chat or anyone else from here.

const BODY_MAX = 4 * 1024;
const CLIENT_ID_REUSED = "clientId was already used for a different action";

const sourceOf = (from: DesignsJob["from"]) => ("card" in from ? `designs:card:${from.card}` : `designs:screen:${from.screen}`);

export function registerDesigns(
  router: Router,
  commands: CommandStore,
  deps: { broadcast: (message: ChatMessage) => void; toMonitor: (entry: AuditEntry) => void },
): void {
  const { config, store, schedules, requireSession, now, refreshWaits } = router.deps;
  const behaviours = new BehavioursStore(config.dataDir);
  router.onClose(() => behaviours.close());
  const row = ALL_BEHAVIOURS.find((behaviour) => behaviour.id === THREE_DESIGNS_ID)!;

  router.on("POST", "/api/designs", async ({ request, response }) => {
    requireSession(request);
    requireSameOrigin(request, config.origin);
    const parsed = designsRequestSchema.safeParse(await readJson(request, BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid 3 designs");
    const { clientId, card, screen } = parsed.data;
    const knobs = behaviours.get(OWNER, row).value as Designs;
    if (!knobs.on) throw new HttpError(409, "3 designs is off in Settings › Behaviours");
    const from: DesignsJob["from"] = card !== undefined ? { card } : { screen: screen! };
    const source = sourceOf(from);
    // From here to the writes there is no await, so a retry cannot slip in between.
    const prior = commands.getActionByClientId(`designs-${clientId}`);
    if (prior) {
      if (prior.ask?.source !== source) throw new HttpError(409, CLIENT_ID_REUSED);
      json(response, 200, { ask: settle(prior), already: false });
      return;
    }
    const at = now();
    if (card !== undefined && !openBoard(store, schedules, store.getBoard()?.board ?? null, at)?.needs.some((need) => need.id === card)) throw new HttpError(404, "no such card");
    const open = store.listAsks({ limit: MAX_ASKS }).find((ask) => ask.source === source && !isFinished(ask.stage));
    if (open) {
      json(response, 200, { ask: open.id, already: true });
      return;
    }
    if (store.countAsks() >= MAX_ASKS) throw new HttpError(507, `${APP_NAME} holds at most ${MAX_ASKS} asks`);
    const ask = askCreateSchema.parse({ id: nextAskId(store), words: designsWords(from), who: "owner", source });
    const job = designsJob(parsed.data, knobs, appLookPickOf(router), ask.id)!;
    const text = designsLine(job);
    const { entry, message } = commands.addActionWithMessage(
      { id: randomUUID(), clientId: `designs-${clientId}`, kind: "chat", request: { text, ask }, at: at.toISOString() },
      { from: "owner", text },
    );
    if (message) deps.broadcast(message);
    json(response, 201, { ask: settle(entry), already: false });
  });

  /** The ask, made if missing, and its line sent while still queued: the bridge types an id once. */
  function settle(entry: AuditEntry): string {
    const id = ensureAsk(store, entry);
    if (!id) throw new HttpError(409, CLIENT_ID_REUSED);
    refreshWaits();
    if (entry.status === "queued") deps.toMonitor(entry);
    return id;
  }
}
