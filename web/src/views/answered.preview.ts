import type { AnsweredCard, AnsweredResponse, Reopen } from "../../../src/shared/answered.js";
import type { Decision, Need, Reply, ServedNeed } from "../../../src/shared/board.js";

// The preview's Cards › Answered (desktop.html?tab=cards): a fixture list, and Reopen and Send again as the server does
// them, so the switch, a row, a reopened card's band and each of its chat states can be shot without a server.
// `?told=not-told|unconfirmed|telling` holds a fresh Reopen's notice at that state; otherwise its chat hears in 3 s.
// `?answered=none` serves an empty list. The answers run from 40 minutes to 3 days ago, so each time chip keeps some.

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

interface Fixture {
  id: string;
  title: string;
  ask: string;
  chat: string;
  pr?: number;
  decision: Decision;
  choice?: string;
  text?: string;
  /** Minutes ago you answered. */
  at: number;
  delivery?: "ok" | "unconfirmed";
  /** The server found its work finished (answeredDone): its PR merged, or its ask is done. */
  done?: true;
}

const FIXTURES: Fixture[] = [
  { id: "banner-art", title: "Home banner: new art first", ask: "The banner shows the new art before the old. A yes merges it and deploys.", chat: "banner-art", pr: 3990, decision: "choice", choice: "Yes, keep it", at: 40, delivery: "ok", done: true },
  { id: "report-chart", title: "Reports: bigger chart", ask: "The chart is bigger and animates for 3 s. A yes merges it.", chat: "report-chart", pr: 3988, decision: "choice", choice: "Change it", text: "slower, 2 s", at: 62, delivery: "unconfirmed" },
  { id: "checkout-saved", title: "Checkout: SAVED by the bar", ask: "SAVED closes up to the bar on a small phone.", chat: "checkout-bar", pr: 3984, decision: "approve", at: 4 * 60, delivery: "ok", done: true },
  { id: "pricing-table", title: "Pricing: plan table", ask: "The plan table shows its prices beside the names.", chat: "pricing-table", pr: 3975, decision: "approve", at: 15 * 60, delivery: "ok", done: true },
  { id: "session-keys-30", title: "Session keys: 30 days", ask: "How long a session key is kept.", chat: "session-keys", decision: "choice", choice: "30 days", at: 15 * 60 + 24, delivery: "ok" },
  { id: "welcome-music", title: "Welcome: intro music", ask: "The intro music: the new loop or the old one?", chat: "welcome-music", decision: "comment", text: "Later, after the art", at: 20 * 60 },
  { id: "upload-sound", title: "Uploads: 50% sound", ask: "A softer chime at half way.", chat: "upload-sound", pr: 3962, decision: "approve", at: 30 * 60, delivery: "ok" },
  { id: "form-refused", title: "Forms: a refused save stays refused", ask: "A refused save stays refused after a reload.", chat: "form-refused", pr: 3955, decision: "approve", at: 40 * 60, delivery: "ok", done: true },
  { id: "landing-banner", title: "Landing: rainbow first banner", ask: "The rainbow banner slides in first.", chat: "landing-banner", pr: 3971, decision: "reject", text: "too dark", at: 3 * 24 * 60, delivery: "ok" },
];

function entry(fixture: Fixture, index: number): AnsweredCard {
  const rev = `a${String(index).repeat(15)}`;
  const card = {
    id: fixture.id,
    kind: "decision",
    title: fixture.title,
    ask: fixture.ask,
    chat: fixture.chat,
    repo: "example-org/example-repo",
    ...(fixture.pr ? { pr: fixture.pr } : {}),
    options: [{ label: "Yes, keep it" }, { label: "Change it", text: true }],
    since: minutesAgo(fixture.at + 90),
    rev,
  } as unknown as ServedNeed;
  const at = minutesAgo(fixture.at);
  const reply: Reply = {
    id: `answered-${fixture.id}`,
    itemId: fixture.id,
    itemTitle: fixture.title,
    decision: fixture.decision,
    ...(fixture.choice ? { choice: fixture.choice } : {}),
    ...(fixture.text ? { text: fixture.text } : {}),
    rev,
    at,
    handled: true,
    item: { id: fixture.id, title: fixture.title, kind: "decision", ask: fixture.ask, chat: fixture.chat, repo: "example-org/example-repo", ...(fixture.pr ? { pr: fixture.pr } : {}) },
    ...(fixture.delivery ? { delivery: { target: "chat" as const, chat: fixture.chat, at, ...(fixture.delivery === "unconfirmed" ? { confirmed: false } : {}) } } : {}),
  };
  return { card, reply, ...(fixture.done ? { done: true as const } : {}) };
}

const params = new URLSearchParams(location.search);
const cards: AnsweredCard[] = params.get("answered") === "none" ? [] : FIXTURES.map(entry);
const reopens: (Reopen & { earlier: Reply })[] = [];
const held = params.get("told");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The preview server's answer to an Answered route, or null for any other URL. `needs` is the preview board's list. */
export function answeredRoute(url: string, method: string, body: string | undefined, needs: Need[]): Response | null {
  if (url === "/api/answered" && method === "GET") {
    const open = reopens.filter((reopen) => needs.some((need) => need.id === reopen.cardId));
    const response: AnsweredResponse = {
      cards,
      reopened: open.map((reopen) => (held === "not-told" && !reopen.delivery ? { ...reopen, expired: true as const } : reopen)),
    };
    return json(response);
  }
  const again = /^\/api\/board\/needs\/([^/]+)\/again$/.exec(url);
  if (again && method === "POST") {
    const id = decodeURIComponent(again[1]!);
    const at = cards.findIndex((one) => one.card.id === id);
    if (at < 0) return json({ error: "that card is no longer kept" }, 404);
    const { card, reply } = cards.splice(at, 1)[0]!;
    const { rev: _rev, ...need } = card;
    const now = new Date().toISOString();
    needs.push({ ...need, again: { n: 1, after: reply.id, at: now } } as Need);
    // The preview board serves each card's rev from its place in the list (desktop.preview.ts GET /api/board).
    const rev = String(needs.length - 1).repeat(16);
    const reopen: Reopen & { earlier: Reply } = { id: `reopen-${id}`, cardId: id, rev, at: now, replyId: reply.id, title: card.title, chat: card.chat, repo: card.repo!, earlier: reply };
    reopens.push(reopen);
    if (!held) setTimeout(() => (reopen.delivery = { at: new Date().toISOString(), confirmed: true }), 3000);
    if (held === "unconfirmed") reopen.delivery = { at: now, confirmed: false };
    return json({ version: 2, updatedAt: now, item: { ...needs[needs.length - 1], rev } });
  }
  if (url === "/api/answered/reopen-send" && method === "POST") {
    const { id } = JSON.parse(body ?? "{}") as { id: string };
    const reopen = reopens.find((one) => one.id === id);
    if (!reopen) return json({ error: "no such reopen" }, 404);
    reopen.sentAt = new Date().toISOString();
    reopen.delivery = { at: reopen.sentAt, confirmed: true };
    return json(reopen);
  }
  return null;
}
