import { chatName } from "../../../src/shared/names.js";
import type { ComingItem } from "../../../src/shared/board.js";
import { NO_REPO } from "../../../src/shared/repos.js";
import type { Worker } from "../../../src/shared/workers.js";
import { NEEDS_YOU } from "../../../src/shared/words.js";
import { h } from "../dom.js";
import { atWork } from "../state.js";
import { cleanComing, type Repo } from "./queue-cards.js";

// Which Coming items show: all, the ones no chat is at work on, the ones a chat is at work on, the ones waiting on your
// OK, or the ones already shipped. The choice stays on this device, like the sort.

export const COMING_FILTERS = ["all", "not-started", "in-progress", "owner-ok", "done"] as const;
export type ComingFilter = (typeof COMING_FILTERS)[number];

const LABELS: Record<ComingFilter, string> = {
  all: "All",
  "not-started": "Not at work",
  "in-progress": "In hand",
  "owner-ok": NEEDS_YOU,
  done: "Done",
};
const KEY = "rivet.coming.filter";

let current: ComingFilter | null = null;

export function comingFilter(): ComingFilter {
  if (current) return current;
  try {
    const saved = localStorage.getItem(KEY);
    current = COMING_FILTERS.find((filter) => filter === saved) ?? "all";
  } catch {
    current = "all";
  }
  return current;
}

export function setComingFilter(filter: ComingFilter): void {
  current = filter;
  try {
    localStorage.setItem(KEY, filter);
  } catch {
    // Private mode: the choice lasts until the page closes.
  }
}

/** Forgets the cached choice, so the next read comes from storage (tests). */
export function resetComingFilter(): void {
  current = null;
}

const NONE: ReadonlySet<ComingItem> = new Set();

/**
 * Coming with the chats at work in it: each holds one row, its first item still on its way and not waiting on you,
 * else a row made from the chat. In progress is those rows, so it counts exactly the chats the desks count. Run again on its own rows it adds none.
 * `repoOf` gives an item's repo as the Feed reads it (null: two repos claim it), so a chat only holds its own repo's row.
 */
export function comingRows(
  items: readonly ComingItem[],
  crew: readonly Worker[] = atWork(),
  repoOf: (item: ComingItem) => Repo | null | undefined = () => null,
): { rows: ComingItem[]; held: ReadonlySet<ComingItem>; heldBy: ReadonlyMap<string, ComingItem> } {
  const rows = [...items];
  const held = new Set<ComingItem>();
  const heldBy = new Map<string, ComingItem>();
  const onItsWay = (item: ComingItem) => {
    const { stage, mergedAt } = cleanComing(item);
    return stage !== "shipped" && stage !== "owner-ok" && !mergedAt;
  };
  const sameRepo = (item: ComingItem, worker: Worker) => {
    const repo = repoOf(item);
    return repo === null || (repo ?? NO_REPO) === worker.repo;
  };
  const atWorkNow = new Set(crew.map((worker) => chatKey(worker.repo, worker.chat)));
  for (const worker of crew) {
    // Its own name first, else a numbered one (`search-box-73` is search-box's), as the Feed reads a row's chat; never a
    // row naming another chat at work in its repo.
    const free = rows.filter((item) => !held.has(item) && onItsWay(item) && sameRepo(item, worker));
    const own =
      free.find((item) => item.chat === worker.chat) ??
      free.find((item) => item.chat?.replace(/-\d+$/, "") === worker.chat && !atWorkNow.has(chatKey(worker.repo, item.chat)));
    const row = own ?? fromChat(worker);
    if (!own) rows.push(row);
    held.add(row);
    heldBy.set(chatKey(worker.repo, worker.chat), row);
  }
  return { rows, held, heldBy };
}

/** The key `comingRows` files each chat's held row under: its repo and its name. */
export const chatKey = (repo: string | undefined, chat: string): string => `${repo ?? NO_REPO}\n${chat}`;

/** A chat's own row keeps the chat's repo, so it opens that chat even where another repo has one of the same name. */
export const chatRowRepo = (item: ComingItem): Repo | undefined => (item as { chatRepo?: Repo }).chatRepo;

function fromChat(worker: Worker): ComingItem {
  return {
    title: worker.what ?? worker.doing ?? chatName(worker.chat),
    chat: worker.chat,
    chatRepo: worker.repo,
    stage: "building",
    ...(worker.progress !== undefined ? { progress: worker.progress } : {}),
    ...(worker.etaMinutes !== undefined ? { etaMinutes: Math.round(worker.etaMinutes) } : {}),
    ...(worker.updatedAt ? { updatedAt: worker.updatedAt } : {}),
  };
}

/** Where an item sits for the filter: done, waiting on your OK, held by a chat at work, else no chat is at work on it. */
export function comingGroup(item: ComingItem, held: ReadonlySet<ComingItem> = NONE): Exclude<ComingFilter, "all"> {
  const { stage, mergedAt } = cleanComing(item);
  if (stage === "shipped" || mergedAt) return "done";
  if (stage === "owner-ok") return "owner-ok";
  return held.has(item) ? "in-progress" : "not-started";
}

export function filterComing<T extends ComingItem>(items: readonly T[], filter: ComingFilter, held: ReadonlySet<ComingItem> = NONE): T[] {
  return filter === "all" ? [...items] : items.filter((item) => comingGroup(item, held) === filter);
}

/** The chips, each with its count; `onPick` runs after a new choice is kept. */
export function comingFilterBar(items: readonly ComingItem[], onPick: () => void, held: ReadonlySet<ComingItem> = NONE): HTMLElement {
  const now = comingFilter();
  return h(
    "div",
    { class: "cfilter", attrs: { role: "group", "aria-label": "Show coming" } },
    ...COMING_FILTERS.map((filter) => {
      const count = filterComing(items, filter, held).length;
      return h(
        "button",
        {
          class: `cfilter-chip${filter === now ? " on" : ""}`,
          attrs: { type: "button", "data-filter": filter, "aria-pressed": String(filter === now), "data-use": `coming.filter.${filter}` },
          on: {
            click: () => {
              if (filter === comingFilter()) return;
              setComingFilter(filter);
              onPick();
            },
          },
        },
        h("span", { class: "cfilter-t" }, LABELS[filter]),
        h("span", { class: "cfilter-n" }, String(count)),
      );
    }),
  );
}
