import { MEDIA_CURSOR, MEDIA_PAGE_MAX, type MediaItem, type MediaPage } from "../../shared/media.js";
import { EARLIER_REF, type CommandStore } from "../commandstore.js";
import { HttpError, json } from "../httputil.js";
import type { Router } from "./router.js";

/**
 * The Media tab: every photo and video Rivet sent you. Each board write records its cards' media (the board as the
 * app starts, too, so cards from before the record are in it, then the rest of the store as earlier cards); chat media
 * are recorded as CommandStore stores them.
 */
export function registerMedia(router: Router, commands: CommandStore): void {
  const { store, requireSession, now } = router.deps;
  commands.recordCards(store.getBoard()?.board.needs ?? [], now().toISOString(), true);
  commands.recordEarlier();
  router.onClose(store.onBoard((board) => commands.recordCards(board.needs, now().toISOString())));

  router.on("GET", "/api/media", ({ request, response, url }) => {
    requireSession(request);
    const cursor = url.searchParams.get("before");
    const match = cursor === null ? null : MEDIA_CURSOR.exec(cursor);
    if (cursor !== null && !match) throw new HttpError(400, "invalid cursor");
    const rows = commands.mediaSeen(match ? { at: match[1]!, seq: Number(match[2]) } : null, MEDIA_PAGE_MAX);
    const page = rows.slice(0, MEDIA_PAGE_MAX);
    const onBoard = new Set((store.getBoard()?.board.needs ?? []).map((need) => need.id));
    const items = page.map((row): MediaItem => {
      const item: MediaItem = { sha: row.sha, type: row.type, at: row.at, source: row.source, title: row.title ?? "" };
      if (row.poster) item.poster = row.poster;
      if (row.source === "chat") {
        const conversation = row.conversation ?? row.ref;
        item.title = commands.conversationTitle(conversation) ?? "Chat";
        // A message the retention sweep deleted keeps its photo here, with nothing to open.
        if (commands.getChatMessage(row.ref) !== null) item.chat = { conversation, message: row.ref };
        return item;
      }
      if (row.ref.startsWith(EARLIER_REF)) return item;
      const reply = store.cardAnswer(row.ref, row.title ?? "", row.at);
      item.card = { id: row.ref, onBoard: onBoard.has(row.ref) };
      if (reply?.item.ask) item.card.ask = reply.item.ask;
      if (reply) {
        const { decision, choice, text, at } = reply;
        item.card.answer = { decision, at, ...(choice !== undefined ? { choice } : {}), ...(text !== undefined ? { text } : {}) };
      }
      return item;
    });
    const last = page.at(-1);
    const body: MediaPage = { items, next: rows.length > MEDIA_PAGE_MAX && last ? `${last.at}~${last.seq}` : null };
    json(response, 200, body);
  });
}
