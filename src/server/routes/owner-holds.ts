import { NO_REPO } from "../../shared/repos.js";
import { holdsPr, MAX_OWNER_HOLDS, ownerHoldPutSchema, type OwnerHold, type OwnerHoldsResponse } from "../../shared/owner-holds.js";
import { hasBearer, HttpError, json, readJson, requireBearer } from "../httputil.js";
import { parseRedacted } from "../redact.js";
import { OpsStore } from "../ops/store.js";
import type { Router } from "./router.js";

// Your own holds (shared/owner-holds.ts): `rivet hold` and `rivet unhold` write them with the board token, on your
// message or card answer; the Ops pass cards each one. Nothing else writes them: a hold read from PR text never does.

const BODY_MAX = 4 * 1024;
const PREFIX = "/api/ops/holds/";

export function register(router: Router): void {
  const { config, requireSession, now } = router.deps;
  const ops = new OpsStore(config.dataDir);
  router.onClose(() => ops.close());
  const list = (): OwnerHold[] => ops.get("ownerHolds") ?? [];

  router.on("GET", "/api/ops/holds", ({ request, response }) => {
    if (!hasBearer(request, config.boardTokenDigest)) requireSession(request);
    const body: OwnerHoldsResponse = { holds: list() };
    json(response, 200, body);
  });

  // One open-ended hold per PR, as holds.json keeps one: a second hold leaves the first, and its card, as they are.
  router.onPrefix("PUT", PREFIX, async ({ request, response, url }) => {
    requireBearer(request, config.boardTokenDigest);
    const pr = prOf(url.pathname);
    const parsed = parseRedacted(ownerHoldPutSchema, await readJson(request, BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid hold", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    // From here to the write there is no await, so two holds cannot interleave.
    const holds = list();
    const known = holds.find((one) => holdsPr(one, pr, parsed.data.repo ?? NO_REPO));
    if (known) return json(response, 200, { hold: known, added: false });
    if (holds.length >= MAX_OWNER_HOLDS) throw new HttpError(507, `at most ${MAX_OWNER_HOLDS} holds; release one first`);
    const at = now();
    const hold: OwnerHold = { pr, repo: parsed.data.repo ?? NO_REPO, reason: parsed.data.reason, at: at.toISOString() };
    ops.put("ownerHolds", [...holds, hold], at);
    json(response, 201, { hold, added: true });
  });

  router.onPrefix("DELETE", PREFIX, ({ request, response, url }) => {
    requireBearer(request, config.boardTokenDigest);
    const pr = prOf(url.pathname);
    const repo = url.searchParams.get("repo") ?? NO_REPO;
    const holds = list();
    const kept = holds.filter((one) => !holdsPr(one, pr, repo));
    if (kept.length !== holds.length) ops.put("ownerHolds", kept, now());
    json(response, 200, { removed: holds.length - kept.length });
  });
}

function prOf(pathname: string): number {
  const rest = pathname.slice(PREFIX.length);
  if (!/^[1-9]\d{0,8}$/.test(rest)) throw new HttpError(400, "the PR is its number");
  return Number(rest);
}
