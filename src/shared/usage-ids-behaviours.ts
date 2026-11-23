import type { UsageId } from "./usage-ids.js";

// Settings › Behaviours' ids, in a file of their own beside the registry so other edits to usage-ids.ts and
// these never touch the same lines.

const ADDED = "2026-11-22";

const SETTINGS_IDS: UsageId[] = (
  [
    ["settings.tab.general", "Settings: General tab"],
    ["settings.tab.behaviours", "Settings: Behaviours tab"],
    ["settings.behaviours.toggle", "A behaviour on or off"],
    ["settings.behaviours.knob", "A behaviour's setting"],
    ["settings.behaviours.open", "Open a behaviour's section"],
    ["settings.behaviours.retry", "Retry behaviours"],
  ] as const
).map(([id, label]) => ({ id, kind: "control", label, where: "Settings", added: ADDED }));

// The behaviours' own controls elsewhere in the app: the Promise keeper's list under Chat's options.
const FEATURE_IDS: UsageId[] = [{ id: "chat.not-done", kind: "control", label: "Anything I asked not done?", where: "Chat", added: ADDED }];

export const BEHAVIOUR_USAGE_IDS: UsageId[] = [...SETTINGS_IDS, ...FEATURE_IDS];
