import { json, readJson, requireBearer } from "../httputil.js";
import { MODEL_JOBS, modelReportSchema, picksFromFile, type ModelReport, type ModelSettingsResponse } from "../../shared/models.js";
import { parseRedacted } from "../redact.js";
import type { Router } from "./router.js";

// Settings › Who does what. Saving goes through POST /api/actions/models (routes/command.ts); the bridge then reports
// the Mac's picks file and the readers' fallbacks here, and Settings reads them back.

const REPORT_BODY_MAX = 16 * 1024;

export function register(router: Router): void {
  const { config, bridge, requireSession, now } = router.deps;
  /** The bridge's last report and when it came; in memory, as the bridge reports again on each connect. */
  let last: { report: ModelReport; at: string } | null = null;

  router.on("GET", "/api/settings/models", ({ request, response }) => {
    // The signed-in session is the owner's: Rivet has one login today. A second login needs an owner check here.
    requireSession(request);
    const file = last?.report.file ?? null;
    const body: ModelSettingsResponse = {
      jobs: MODEL_JOBS,
      current: file ? picksFromFile(file.jobs) : null,
      updated: file?.updated ?? null,
      fileError: last?.report.fileError ?? null,
      status: last?.report.status ?? {},
      reportedAt: last?.at ?? null,
    };
    json(response, 200, body);
  });

  router.on("PUT", "/api/bridge/models", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(modelReportSchema, await readJson(request, REPORT_BODY_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid models report", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    bridge.seen();
    // The loop's report and a save's can cross on the way: one read before the kept one is older news. Without readAt (an older bridge) it is taken as now.
    // readAt is the Mac's clock, rising only within one bridge run, so a report from another run always lands. Arrival
    // can't order two runs either: a late report from a run that has ended lands too, and the live run's next report (at
    // most 5 minutes) replaces it. A save made on that view is refused on the Mac, never written.
    const kept = last && last.report.run === parsed.data.run ? last.report.readAt : undefined;
    if (kept !== undefined && parsed.data.readAt !== undefined && parsed.data.readAt < kept) {
      json(response, 200, { ok: true, stale: true });
      return;
    }
    last = { report: parsed.data, at: now().toISOString() };
    json(response, 200, { ok: true });
  });
}
