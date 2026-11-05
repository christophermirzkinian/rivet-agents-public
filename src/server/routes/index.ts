import * as answered from "./answered.js";
import * as asks from "./asks.js";
import * as claims from "./claims.js";
import * as command from "./command.js";
import * as home from "./home.js";
import * as mind from "./mind.js";
import * as morning from "./morning.js";
import * as ops from "./ops.js";
import * as opsStatus from "./ops-status.js";
import * as ownerHolds from "./owner-holds.js";
import type { Router } from "./router.js";
import * as schedules from "./schedules.js";
import * as settings from "./settings.js";
import * as shortTitles from "./short-titles.js";
import * as summary from "./summary.js";
import * as updates from "./updates.js";
import * as usage from "./usage.js";

/** One module per area; each adds its routes in register(router). */
const AREAS: { register(router: Router): void }[] = [ops, opsStatus, ownerHolds, command, asks, schedules, claims, morning, updates, home, mind, summary, answered, usage, shortTitles, settings];

export function registerRoutes(router: Router): void {
  for (const area of AREAS) area.register(router);
}
