// Dev-only preview of the Chat tab (web/preview/chat.html), on made-up data with no sign-in.
// ?thing=<id> opens Chat on that thing's newest line, &line=<id> on that line. Nothing imports this from the app, so the production build leaves it out.
import "../styles.css";

import type { BoardResponse, ServedNeed } from "../../../src/shared/board.js";
import type { ChatMessage } from "../../../src/shared/command.js";
import { chatBadge, type ConversationDetail, type ConversationSummary } from "../../../src/shared/conversations.js";
import type { WorkersResponse } from "../../../src/shared/workers.js";
import { app } from "../state.js";
import { showLine } from "./chat.js";
import { drawnStill, drawPreviewMedia, previewMediaFile } from "./media.preview.js";
import { mountShell } from "./shell.js";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const R = "example-org/example-repo";

/** Rivet's PDF (say.mjs --file), served below as a one-page sample so the viewer has something to draw. */
const PDF_SHA = "5".repeat(64);
function samplePdf(): Blob {
  const lines = ["Quarterly report (v2)", "Signups up 12%", "Costs down 4%", "Margin 31%"];
  const stream = `BT /F1 22 Tf 60 760 Td 30 TL ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const at = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([body], { type: "application/pdf" });
}

const say = (id: string, thread: string, minutes: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: "rivet",
  text,
  at: ago(minutes),
  threadId: thread,
  ...extra,
});
const mine = (id: string, thread: string, minutes: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: "owner",
  text,
  at: ago(minutes),
  status: "replied",
  threadId: thread,
  ...extra,
});

const messages: ChatMessage[] = [
  mine("m1", "m1", 240, "Morning. What's on today?"),
  say("m2", "m1", 239, "Three things building, one waiting on your look. CI is green."),
  mine("r1", "r1", 200, "Sam wants a colour picker: five colour discs, saved between visits"),
  say("r2", "r1", 199, "Got it. Plan card coming."),
  say("r3", "r1", 198, "Card: Plan", { posted: { id: "plan-colours", kind: "plan", title: "Plan: Colour picker", ask: "Five colour discs on the theme engine, saved between visits. Size M." } }),
  mine("r4", "r1", 188, "Approved: Plan\nYes", { card: "plan-colours", status: "sent" }),
  say("r5", "r1", 120, "Engine wired, UI next. Tests are on CI."),
  say("r6", "r1", 40, "Card: Stills", { posted: { id: "stills-colours", kind: "decision", title: "Picks row on a narrow phone", ask: "Big discs, five in a row on top. Good to go?" } }),
  mine("r7", "r1", 30, "Make the discs bigger, Sam won't see those on a phone"),
  say("r8", "r1", 28, "Bigger discs coming in the next stills."),
  mine("k1", "k1", 90, "Checkout results row is too small on Sam's phone"),
  say("k2", "k1", 89, "Card: Plan", { posted: { id: "plan-checkout", kind: "plan", title: "Plan: Checkout results row", ask: "Results row 30% taller, numbers 20px. Size S." } }),
  mine("s1", "s1", 75, "Research the top 10 note-taking apps on iOS and Android"),
  say("s2", "s1", 70, "Card: Findings", { posted: { id: "apps-findings", kind: "decision", title: "Top 10 note-taking apps research", ask: "Ten apps, what they share. Anything to build?" } }),
  mine("s3", "s1", 17, "Dismissed", { card: "apps-findings", status: "sent" }),
  mine("s4", "s1", 15, "Colour picker: the discs need to be bigger"),
  mine("s5", "s1", 14, "And put the logo on the wheel"),
  say("s6", "s1", 12, "Got both. A plan card for the discs and the logo next.", { replyTo: "s4" }),
  say("s7", "s1", 5, "Card: Plan", { replyTo: "s5", posted: { id: "discs-logo-plan", kind: "plan", title: "Plan: bigger discs, logo in the middle", ask: "Discs 40% bigger, the logo in the centre. Size S." } }),
  mine("j1", "j1", 150, "Is the Demo video ready?"),
  say("j2", "j1", 149, "Card: Video", { posted: { id: "demo-video", kind: "decision", title: "Demo video", ask: "Fifteen seconds, sign-up to first note. Put it on the site?" } }),
  mine("j3", "j1", 22, "Chose: Yes, put it on the site", { card: "demo-video", status: "sent" }),
  mine("l1", "l1", 2, "I lost some asks just now in chat? What happened to my asks on the colour picker?"),
  mine("g1", "g1", 60, "Is CI green?"),
  say("g2", "g1", 59, "Yes. Main is green, the last run took 11 minutes."),
  mine("g3", "g1", 12, "Good. Remind me at 5 about the quote form"),
  say("g4", "g1", 11, "Will do, 5pm."),
  mine("v1", "v1", 8, "Send me the quarterly report"),
  say("v2", "v1", 6, "Here it is, v2 with the summary table.", { files: [{ sha256: PDF_SHA, name: "Quarterly report (v2).pdf", bytes: 482_000 }] }),
];
/** Lines saved in the preview, newest saved first: Rivet's, a short one and one of his. */
let savedIds = [
  { id: "k4", at: ago(1) },
  { id: "g4", at: ago(10) },
  { id: "r7", at: ago(29) },
];

const titles: Record<string, string> = { v1: "Quarterly report", j1: "Demo video",s1: "Top 10 note-taking apps research on iOS and Android", l1: "Lost asks", m1: "Morning", r1: "Colour picker", k1: "Checkout results row", g1: "CI" };
const extra: Record<string, Partial<ConversationSummary>> = {
  r1: { links: { prs: ["#42"], chats: ["colour-picker"], tag: "Colours" }, stage: "open", stagePr: "#42", unread: 1 },
  k1: { needsYou: true, phase: "waiting" },
  g1: { unread: 1 },
};
const conversationOf = (message: ChatMessage) => message.threadId ?? message.id;

function summary(id: string): ConversationSummary {
  const own = messages.filter((message) => conversationOf(message) === id);
  const last = own.at(-1)!;
  return {
    id,
    title: titles[id] ?? id,
    lastAt: last.at,
    lastFrom: last.from,
    lastText: last.text.split("\n")[0]!,
    unread: 0,
    needsYou: false,
    links: { prs: [], chats: [], tag: null },
    closed: false,
    updates: false,
    appOnly: false,
    markedUnread: false,
    pinned: false,
    done: false,
    stage: "none",
    phase: null,
    thing: own.some((message) => !!message.posted),
    ...extra[id],
  };
}

function detail(id: string): ConversationDetail {
  const own = messages.filter((message) => conversationOf(message) === id);
  const row = summary(id);
  return {
    id,
    title: row.title,
    status: null,
    statusFrom: null,
    project: null,
    tag: row.links.tag,
    ball: null,
    startedBy: own[0]!.from,
    count: own.length,
    lastAt: row.lastAt,
    lastFrom: row.lastFrom,
    lastText: row.lastText,
    steps: [],
    messages: own,
    more: false,
    conversation: row,
  };
}

/** ?collecting=1: two lines of the owner's still collecting, sent 9.5s after the page opens unless Cancel takes them back. */
const collecting = new URLSearchParams(location.search).has("collecting");
const sendsAt = new Date(Date.now() + 9_500).toISOString();
let held = collecting
  ? [
      mine("c1", "c1", 0.2, "Can the send button be bigger on Settings?", { status: "collecting", sendsAt }),
      mine("c2", "c1", 0.05, "and green, not orange", { status: "collecting", sendsAt }),
    ]
  : [];

/** As GET /api/chat?chat=1: every line but the old Updates, a thing's too. */
function chatLines(): ChatMessage[] {
  const due = Date.now() >= Date.parse(sendsAt);
  const extra = held.map((message) => (due ? { ...message, status: "sent" as const, sendsAt: undefined } : message));
  return [...messages, ...extra].sort((a, b) => a.at.localeCompare(b.at));
}

const needs = [
  { id: "plan-checkout", kind: "plan", title: "Plan: Checkout results row", ask: "Results row 30% taller, numbers 20px. Size S.", rev: "r1", chat: "checkout-results" },
  {
    id: "stills-colours",
    kind: "decision",
    title: "Picks row on a narrow phone",
    ask: "Big discs, five in a row on top. Good to go?",
    rev: "r1",
    chat: "colour-picker",
    pr: 4706,
    eta: "2:30pm",
    links: [{ label: "Preview", url: "https://preview.example.com/colour-picker" }],
    media: { kind: "stills", stills: [{ sha256: drawnStill("a".repeat(64), "Picks row", 212), type: "image/png" }] },
  },
] as unknown as ServedNeed[];
const board: BoardResponse = {
  version: 1,
  updatedAt: ago(0),
  board: { updatedAt: ago(0), needs, coming: [], chats: [], shipped: [] },
} as unknown as BoardResponse;
const workers = {
  at: ago(0),
  workers: [{ id: "w1", name: "Colours", repo: R, chat: "colour-picker", state: "working", lastOutputAt: now - 60_000 }],
} as unknown as WorkersResponse;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const passThrough = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  const path = url.pathname;
  if (path === `/media/${PDF_SHA}`) return new Response(samplePdf(), { headers: { "content-type": "application/pdf" } });
  if (path.startsWith("/media/")) return (await previewMediaFile(path)) ?? passThrough(input, init);
  if (path === "/api/board") return json(board);
  if (path === "/api/workers") return json(workers);
  if (path === "/api/replies") return json({ replies: [] });
  // One ask with a time, so the head's clock shows: ?late=1 makes it late (the clock turns amber).
  if (path === "/api/asks")
    return json({
      asks: [
        { id: "a-91", words: "Poster stills", short: "Poster stills", stage: "building", at: ago(60), dueAt: ago(new URLSearchParams(location.search).has("late") ? 12 : -27) },
        { id: "a-92", words: "Promo video", short: "Promo video", stage: "building", at: ago(30), dueAt: ago(-55) },
        // Done lately, for the clock's Done tab.
        { id: "a-81", words: "Card poster", short: "Card poster", stage: "live", prs: [101], stageAt: ago(38) },
        { id: "a-82", words: "Export rules", short: "Export rules", stage: "done", prs: [102], stageAt: ago(52) },
        { id: "a-83", words: "Tables in more languages", short: "Tables in more languages", stage: "live", prs: [103], stageAt: ago(90) },
        { id: "a-84", words: "Repo move", short: "Repo move", stage: "done", prs: [104], stageAt: ago(129) },
        { id: "a-85", words: "Chat text size", short: "Chat text size", stage: "live", prs: [105], stageAt: ago(670) },
      ],
    });
  if (path === "/api/status")
    return json({ board: { version: 1, updatedAt: ago(0) }, bridge: { connected: true, lastSeenAt: ago(0) } });
  if (path === "/api/chat" && (init?.method ?? "GET") === "GET") return json({ messages: chatLines(), older: null });
  if (path === "/api/chat/cancel") {
    if (!held.length || Date.now() >= Date.parse(sendsAt)) return json({ error: "Too late: it's on its way to Rivet." }, 409);
    const back = { ids: held.map((message) => message.id), clientIds: [], text: held.map((message) => message.text).join("\n"), images: [], files: [] };
    held = [];
    return json(back);
  }
  if (path === "/api/conversations") {
    const rows = Object.keys(titles).map(summary);
    return json({ conversations: rows, older: 0, unread: chatBadge(rows) });
  }
  const one = /^\/api\/conversations\/([^/]+)$/.exec(path);
  // A read mark holds, as on the server, so a topic he opened is not New again on the next list.
  const read = (id: string) => (extra[id] = { ...extra[id], unread: 0, markedUnread: false });
  if (one && init?.method === "PATCH") {
    const wanted = decodeURIComponent(one[1]!);
    const found = messages.find((message) => message.id === wanted || message.posted?.id === wanted);
    if (!found) return json({ error: "no such conversation" }, 404);
    const id = conversationOf(found);
    const patch = JSON.parse(String(init.body ?? "{}")) as { read?: unknown; unread?: boolean };
    if (patch.read !== undefined) read(id);
    // Mark unread holds too, so the chip's marked-unread half can be seen here.
    if (patch.unread) extra[id] = { ...extra[id], markedUnread: true };
    return json(detail(id));
  }
  if (path === "/api/conversations/batch") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { ids?: string[]; action?: string };
    if (body.action === "read") for (const id of body.ids ?? []) read(id);
    return json({ changed: body.ids?.length ?? 0 });
  }
  if (path === "/api/conversations/read" && init?.method === "POST") {
    // Mark all read: every topic read, as the server does, so the chip's All read can be seen here.
    const ids = new Set(messages.map(conversationOf));
    for (const id of ids) read(id);
    return json({ read: ids.size });
  }
  if (one) {
    // A thing's page by its conversation id, or by the id of a card it posted (?thing=plan-colours).
    const wanted = decodeURIComponent(one[1]!);
    const found = messages.find((message) => message.id === wanted || message.posted?.id === wanted);
    return found ? json(detail(conversationOf(found))) : json({ error: "no such conversation" }, 404);
  }

  // Saved lines: kept here while the page is open, newest saved first.
  if (path === "/api/chat/saved") {
    const saved = savedIds.flatMap((one) => {
      const found = messages.find((message) => message.id === one.id);
      return found ? [{ ...found, conversation: conversationOf(found), savedAt: one.at }] : [];
    });
    return json({ saved });
  }
  const savedOne = /^\/api\/chat\/saved\/([^/]+)$/.exec(path);
  if (savedOne) {
    const id = decodeURIComponent(savedOne[1]!);
    savedIds = savedIds.filter((one) => one.id !== id);
    if (init?.method === "PUT") savedIds.unshift({ id, at: new Date().toISOString() });
    return json({ ok: true });
  }
  return json({ error: "not in the preview" }, 404);
};

app.board = board;
app.workers = workers;
app.workersAt = Date.now();
app.tab = "chat";
drawPreviewMedia();
const thing = new URLSearchParams(location.search).get("thing");
// &line=<id> is a notification's tap: Chat opens on that line.
if (thing) showLine(thing, new URLSearchParams(location.search).get("line"));
mountShell(document.getElementById("app")!);
