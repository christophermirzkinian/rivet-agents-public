// Reply style and text size live in Settings › Behaviours' store. Each phone keeps its copy in localStorage, read at
// boot before the list answers. The first list with no stored value takes the phone's own pick once; after that the
// store is the truth and the phone's copy follows it.
import { REPLY_STYLE_ID, TEXT_SIZE_ID, type BehaviourRow, type BehaviourValue } from "../../../src/shared/behaviours.js";
import * as api from "../api.js";
import { onSessionReset, StaleSession } from "../session.js";
import { isStyle, savedChatReplyStyle, setChatReplyStyle } from "./chat-reply-style.js";
import { isSize, savedChatTextSize, setChatTextSize } from "./chat-text-size.js";
import { flash } from "./toast.js";

interface Pref {
  key: string;
  saved(): string | null;
  cache(value: unknown): void;
}

function pref(id: string): Pref | null {
  if (id === REPLY_STYLE_ID) return { key: "style", saved: savedChatReplyStyle, cache: (value) => isStyle(value) && setChatReplyStyle(value) };
  if (id === TEXT_SIZE_ID) return { key: "size", saved: savedChatTextSize, cache: (value) => isSize(value) && setChatTextSize(value) };
  return null;
}

/** Local picks and Settings saves invalidate only that preference in an older list. */
const versions = new Map<string, number>();
/** Chat picks whose save has not answered yet: no list read before it landed may move that preference. */
const pending = new Map<string, number>();

/** Taken before a list is requested, and passed to syncChatPrefs with its answer. */
export function chatPrefsMark(): ReadonlyMap<string, number> {
  return new Map(versions);
}

/** Chat picks only, counted per preference: a Settings save sent before one must not undo it. */
const picks = new Map<string, number>();
/** A save from a session that has ended settles nothing in the next one. */
let session = 0;
onSessionReset(() => {
  session += 1;
  pending.clear();
});

/** Taken when Settings sends a save, and passed to cacheChatPref with its answer. */
export function chatPicksMark(): ReadonlyMap<string, number> {
  return new Map(picks);
}

/** Whether a list sent at `before` is older than a Chat pick on this preference, landed or not. */
function overtaken(id: string, before: ReadonlyMap<string, number>): boolean {
  return before.get(id) !== versions.get(id) || (pending.get(id) ?? 0) > 0;
}

/** The phone's copy follows a stored row, unless a Chat pick came after the save was sent (`picksBefore`). */
export function cacheChatPref(row: BehaviourRow, picksBefore?: ReadonlyMap<string, number>): void {
  const found = pref(row.id);
  if (found && row.updatedAt !== null && !(picksBefore && picksBefore.get(row.id) !== picks.get(row.id))) {
    versions.set(row.id, (versions.get(row.id) ?? 0) + 1);
    found.cache(row.value?.[found.key]);
  }
}

/**
 * Each row's carry-over save, one per session: startApp and Settings both list at sign-in, and a list read before the
 * save landed still shows nothing stored, so a second caller gets the first one's answer rather than saving again.
 */
const carried = new Map<string, Promise<BehaviourRow>>();
onSessionReset(() => carried.clear());

function carry(row: BehaviourRow, key: string, local: string): Promise<BehaviourRow> {
  let saving = carried.get(row.id);
  if (!saving) {
    saving = api.putBehaviour(row.id, { [key]: local });
    carried.set(row.id, saving);
    // A failed save may be tried again by a later list.
    saving.catch(() => carried.get(row.id) === saving && carried.delete(row.id));
  }
  // Not saved: the row shows the pick the phone is using, not the default.
  return saving.catch(() => ({ ...row, value: { [key]: local } }));
}

/** The rows with the phone's own pick saved where the store has none yet, and the phone's copy following the rest. */
export async function syncChatPrefs(rows: readonly BehaviourRow[], before: ReadonlyMap<string, number>): Promise<BehaviourRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      const found = pref(row.id);
      if (!found || overtaken(row.id, before)) return row;
      const local = found.saved();
      if (row.updatedAt !== null || local === null) {
        // A list follows the store; only a local pick or Settings save advances its version.
        if (row.updatedAt !== null) found.cache(row.value?.[found.key]);
        return row;
      }
      return carry(row, found.key, local);
    }),
  );
}

/**
 * Chat's pickers, painted again once a list has moved the phone's copy. Held weakly: a picker built before its menu is
 * on the page still repaints once it is, and one the page let go of is dropped.
 */
const pickers = new Set<WeakRef<Element>>();
const paints = new WeakMap<Element, () => void>();

export function repaintAfterList(el: Element, paint: () => void): void {
  paints.set(el, paint);
  pickers.add(new WeakRef(el));
}

/** A pick made in Chat, saved to the store; the phone's copy already holds it, and follows the store again on a failure. */
export function saveChatPref(id: string, value: BehaviourValue, what: string): void {
  versions.set(id, (versions.get(id) ?? 0) + 1);
  picks.set(id, (picks.get(id) ?? 0) + 1);
  pending.set(id, (pending.get(id) ?? 0) + 1);
  const sentIn = session;
  const settle = () => {
    if (sentIn !== session) return;
    // A list sent while this save was out may predate it in the store: its mark no longer matches.
    versions.set(id, (versions.get(id) ?? 0) + 1);
    const left = (pending.get(id) ?? 1) - 1;
    if (left > 0) pending.set(id, left);
    else pending.delete(id);
  };
  api.putBehaviour(id, value).then(settle, (error: unknown) => {
    settle();
    // Signed out before it answered: nothing to tell this session.
    if (error instanceof StaleSession) return;
    flash(`Couldn't save the ${what}. Try again.`, "error");
    void loadChatPrefs();
  });
}

/** The first list after sign-in, for the migration and the phone's copy. */
export async function loadChatPrefs(): Promise<void> {
  const before = chatPrefsMark();
  try {
    await syncChatPrefs((await api.getBehaviours()).behaviours, before);
    for (const ref of pickers) {
      const el = ref.deref();
      if (!el) pickers.delete(ref);
      else if (el.isConnected) paints.get(el)?.();
    }
  } catch {
    // Offline or refused: the phone's copy stands until the next load.
  }
}
