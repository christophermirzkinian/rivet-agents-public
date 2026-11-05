// One-off tidy: merges the conversations a card answer split off into the one the work began in. Read-only unless
// --apply; running it again moves nothing (a merged one answers 0).
//
//   npx tsx scripts/tidy-conversations.ts [--since <iso>] [--pair <from>:<into>]... [--skip <id>]... [--apply]
//
// Groups come from what its card answers and asks name (never a PR its messages only mention): a card id's stem, a PR,
// a chat. The group joins
// its earliest conversation, where the thing began. --pair adds a link only the words make (no id names both);
// --skip leaves a conversation out of the groups (a --pair still places it). Ids may be cut to 8 characters. Token: RIVET_BOARD_TOKEN in the environment, or in the Keychain under service rivet-agents.
import { makeExec, readToken, serverOrigin } from "../bridge/lib/config.mjs";

import { cardKey, MIXED_CHATS } from "../src/server/conversations.js";
import { TEAM_ROOM_ID, UPDATES_ID } from "../src/shared/conversations.js";
import { defaultRepo } from "../src/shared/repos.js";

interface Row { id: string; title: string; lastAt: string }
interface Message { id: string; from: string; at: string; card?: string }
interface Detail { id: string; messages: Message[]; more?: boolean }
interface Reply { id: string; itemId: string; item?: { pr?: number; repo?: string; chat?: string } }
interface Ask { replyId?: string; chat?: string; repo?: string; prs?: number[]; card?: string }

const args = process.argv.slice(2);
const flag = (name: string) => args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
const apply = args.includes("--apply");
const since = flag("--since")[0] ?? new Date(Date.now() - 36 * 3_600_000).toISOString();
const skipped = flag("--skip");
const paired = flag("--pair").map((pair) => pair.split(":") as [string, string]);
const origin = serverOrigin(process.env.RIVET_URL || undefined);
const token = await readToken(makeExec(), "RIVET_BOARD_TOKEN");
const repoOf = (repo: string | undefined) => (repo ?? defaultRepo() ?? "").toLowerCase();

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as T;
}

const rows: Row[] = [...(await api<{ conversations: Row[] }>("/api/conversations")).conversations];
for (let before: string | undefined, page = 0; page < 5; page += 1) {
  const older = await api<{ conversations: Row[]; next?: string }>(`/api/conversations?older=1&limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`);
  rows.push(...older.conversations);
  if (!older.next) break;
  before = older.next;
}
const recent = rows.filter((row) => row.lastAt >= since && ![UPDATES_ID, TEAM_ROOM_ID].includes(row.id));
const replies = new Map((await api<{ replies: Reply[] }>("/api/replies?limit=500")).replies.map((reply) => [reply.id, reply]));
const asks = (await api<{ asks: Ask[] }>("/api/asks?all=1&limit=500")).asks;

const full = (prefix: string) => {
  const found = recent.filter((row) => row.id.startsWith(prefix));
  if (prefix.length < 8 || found.length !== 1) throw new Error(`${prefix}: not one conversation active since ${since}`);
  return found[0]!.id;
};
const skip = new Set(skipped.map(full));
const pairs = paired.map(([from, into]) => [full(from), full(into)] as const);

// Every key a conversation's cards and asks name.
const keys = new Map<string, Set<string>>();
const started = new Map<string, { at: string }>();
for (const row of recent) {
  const detail = await api<Detail>(`/api/conversations/${encodeURIComponent(row.id)}`);
  // Back to its first message: when it began decides which one the rest join, and older answers and asks are keys too.
  // Pages run oldest first, by the order written (as the app pages): each one's first message is the next cursor.
  for (let more = detail.more === true, cursor = detail.messages[0]?.id, page = 0; more && cursor && page < 50; page += 1) {
    const older = await api<{ messages: Message[]; more?: boolean }>(`/api/conversations/${encodeURIComponent(detail.id)}?before=${encodeURIComponent(cursor)}`);
    detail.messages.unshift(...older.messages);
    cursor = older.messages[0]?.id;
    more = older.more === true;
  }
  const root = detail.messages.find((message) => message.id === detail.id);
  if (!root) throw new Error(`${detail.id}: its first message was not found`);
  started.set(detail.id, { at: root.at });
  const own = new Set<string>();
  const pr = (repo: string | undefined, number: number) => own.add(`pr:${repoOf(repo)}#${number}`);
  const chat = (repo: string | undefined, name: string | undefined) => name && !MIXED_CHATS.has(name.toLowerCase()) && own.add(`chat:${repoOf(repo)}:${name.toLowerCase()}`);
  // deploy-101 and deploy-102 are two things: a stem joins only within its repo and PR.
  const stem = (repo: string | undefined, card: string, number: number | undefined) => {
    const key = cardKey(card);
    if (key.stem) own.add(`stem:${repoOf(repo)}:${key.stem}#${number ?? key.pr ?? ""}`);
  };
  const ids = new Set(detail.messages.map((message) => message.id));
  for (const message of detail.messages) {
    if (!message.card) continue;
    // An answer past the newest 500 is read on its own; one not found is no evidence of its repo, so names nothing.
    const reply = replies.get(message.id) ?? (await api<Reply>(`/api/replies/${encodeURIComponent(message.id)}`).catch(() => undefined));
    if (!reply) continue;
    const item = reply.item;
    stem(item?.repo, message.card, item?.pr);
    const number = item?.pr ?? cardKey(message.card).pr;
    if (number !== null) pr(item?.repo, number);
    chat(item?.repo, item?.chat);
  }
  for (const ask of asks.filter((one) => one.replyId && ids.has(one.replyId))) {
    for (const number of ask.prs ?? []) pr(ask.repo, number);
    chat(ask.repo, ask.chat);
    if (ask.card) stem(ask.repo, ask.card, ask.prs?.length === 1 ? ask.prs[0] : undefined);
  }
  keys.set(detail.id, own);
}

// Union by shared key, then the pairs.
const parent = new Map<string, string>();
const find = (id: string): string => (parent.get(id) === undefined || parent.get(id) === id ? id : find(parent.get(id)!));
const why = new Map<string, Set<string>>();
const join = (a: string, b: string, reason: string) => {
  const [ra, rb] = [find(a), find(b)];
  if (ra !== rb) parent.set(rb, ra);
  for (const id of [a, b]) why.set(id, new Set([...(why.get(id) ?? []), reason]));
};
const byKey = new Map<string, string>();
for (const [id, own] of keys) {
  if (skip.has(id)) continue;
  for (const key of own) {
    const first = byKey.get(key);
    if (first) join(first, id, key);
    else byKey.set(key, id);
  }
}
for (const [from, into] of pairs) join(into, from, "pair");

const groups = new Map<string, string[]>();
for (const id of keys.keys()) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
for (const [root, members] of groups) if (members.length < 2) groups.delete(root);
const title = (id: string) => rows.find((row) => row.id === id)?.title ?? id;
const plan: { from: string; into: string }[] = [];
for (const members of groups.values()) {
  const order = [...members].sort((a, b) => started.get(a)!.at.localeCompare(started.get(b)!.at));
  const into = order[0]!;
  console.log(`\n"${title(into)}" ${into}`);
  for (const from of order.slice(1)) {
    console.log(`  ← "${title(from)}" ${from}, by ${[...(why.get(from) ?? [])].join(", ")}`);
    plan.push({ from, into });
  }
}
console.log(`\n${plan.length} merge(s) in ${groups.size} group(s) of ${recent.length} conversation(s) active since ${since}.${apply ? "" : " Dry run: --apply merges."}`);
if (apply) {
  for (const { from, into } of plan) {
    const result = await api<{ moved: number }>(`/api/conversations/${encodeURIComponent(from)}/merge`, { into });
    console.log(`merged ${from} into ${into}: ${result.moved} message(s)`);
  }
}
