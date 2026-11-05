import { json } from "../httputil.js";
import { summaryNow } from "../summary-now.js";
import type { Router } from "./router.js";

// GET /api/summary: every count the app shows, from the functions its lists are built with. The badge, the progress
// mark and the Cards empty line read it.

export function register(router: Router): void {
  const { requireSession, push } = router.deps;
  const current = () => summaryNow(router.deps);

  // The quiet-hours digest opens with what needs you as it goes, so a ping held for a card answered since does not
  // read as waiting.
  router.onClose(push.onDigestLead(() => current().needsYou));

  router.on("GET", "/api/summary", ({ request, response }) => {
    requireSession(request);
    json(response, 200, current());
  });
}
