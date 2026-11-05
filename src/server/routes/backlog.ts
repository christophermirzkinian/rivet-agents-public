import { randomUUID } from "node:crypto";

import { z } from "zod";

import { askCreateSchema, isFinished, MAX_ASKS, type Ask } from "../../shared/asks.js";
import {
  BACKLOG_LABEL_MAX,
  BACKLOG_STALE_MS,
  BACKLOG_TITLE_MAX,
  backlogSource,
  CLOSE_WORDS,
  ISSUE_BODY_MAX,
  ISSUE_KEPT_MS,
  MAX_BACKLOG_ASKS,
  MAX_BACKLOG_LABELS,
  type BacklogAsk,
  type BacklogIssueResponse,
  type BacklogResponse,
  type BacklogStart,
  type IssueDetail,
  type IssueWriteState,
} from "../../shared/backlog.js";
import type { AuditEntry, ChatMessage } from "../../shared/command.js";
import { APP_NAME } from "../../shared/names.js";
import { isKnownRepo, isRepo } from "../../shared/repos.js";
import type { CommandStore } from "../commandstore.js";
import { HttpError, json, readJson, requireBearer, requireSameOrigin } from "../httputil.js";
import { isStale } from "../ops/view.js";
import { parseRedacted } from "../redact.js";
import { ensureAsk, nextAskId } from "./asks.js";
import type { Router } from "./router.js";

// A project's backlog sheet and an issue opened in it. The Mac's bridge reads an issue when it is opened and does the GitHub writes with
// its own gh login, so this server holds no GitHub key and makes no GitHub call. Start work makes one ask per issue and
// a line in your chat to Rivet; Close comments, then closes the issue as not planned.

const BODY_MAX = 4 * 1024;
const ISSUE_PUT_MAX = 256 * 1024;
/** Issues read on tap kept in memory, the oldest read dropped first. */
const ISSUES_KEPT = 100;
/** A read asked of the Mac this recently is not asked again: the page polls while it waits. */
const READ_ASKED_MS = 20_000;
/** Reads asked of the Mac and not yet answered, at most: an issue GitHub lacks is never answered, so each ages out. */
const READS_ASKED_MAX = 8;
/** A close this recent keeps its issue off the list and is what a second Close gets. */
const CLOSE_KEPT_MS = 60 * 60_000;
const CLIENT_ID_REUSED = "clientId was already used for a different action";

const repoField = z.string().refine(isKnownRepo, "repo is not in RIVET_REPOS");
const issueField = z.number().int().positive().max(1_000_000_000);
const writeSchema = z.object({ repo: repoField, issue: issueField, clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).strict();
const issueDetailSchema = z
  .object({
    repo: repoField,
    number: issueField,
    title: z.string().max(BACKLOG_TITLE_MAX),
    body: z.string().max(ISSUE_BODY_MAX),
    author: z.string().max(100).nullable(),
    createdAt: z.string().datetime(),
    state: z.enum(["open", "closed"]),
    url: z.string().max(300),
    comments: z.number().int().nonnegative(),
    labels: z.array(z.string().max(BACKLOG_LABEL_MAX)).max(MAX_BACKLOG_LABELS),
    at: z.string().datetime(),
  })
  .strict()
  .refine((detail) => detail.url === `https://github.com/${detail.repo}/issues/${detail.number}`);

const repoName = (repo: string) => repo.split("/").pop() ?? repo;
const keyOf = (repo: string, issue: number) => `${repo}#${issue}`;

function writeState(entry: AuditEntry): IssueWriteState {
  const status = entry.status === "succeeded" ? "done" : entry.status === "queued" ? "waiting" : "failed";
  const reason = entry.detail?.reason;
  return { id: entry.id, status, at: entry.at, ...(status === "failed" && typeof reason === "string" ? { reason } : {}) };
}

function startOf(ask: Ask): BacklogStart | null {
  if (!ask.repo || ask.issue === undefined || !isRepo(ask.repo)) return null;
  return { repo: ask.repo as BacklogStart["repo"], issue: ask.issue, ask: ask.id, words: ask.words, at: ask.createdAt, stage: ask.stage, ...(ask.chat ? { chat: ask.chat } : {}) };
}

export function registerBacklog(
  router: Router,
  commands: CommandStore,
  deps: { broadcast: (message: ChatMessage) => void; toMonitor: (entry: AuditEntry) => void },
): void {
  const { config, store, bridge, requireSession, now, ops, titles, refreshWaits } = router.deps;
  const read = new Map<string, { detail: IssueDetail; got: number }>();
  const asked = new Map<string, number>();

  function toBridge(entry: AuditEntry): void {
    bridge.sendEvent("issue", entry.id, { id: entry.id, at: entry.at, repo: entry.repo, issue: entry.issue, op: entry.op, ...(entry.op === "label" ? {} : { text: entry.text }) });
  }
  // A GitHub write waits while the Mac is off, then goes on its next attach; the bridge's journal answers one it already
  // did, so a write sent again never runs twice.
  bridge.onAttach(() => {
    for (const entry of commands.queuedIssueWrites()) toBridge(entry);
  });

  /** The close on its way, or done in the last hour, for each repo#issue, newest first. */
  function closing(): Map<string, AuditEntry> {
    const out = new Map<string, AuditEntry>();
    for (const entry of commands.recentCloses(new Date(now().getTime() - CLOSE_KEPT_MS).toISOString())) {
      if (entry.repo && entry.issue && !out.has(keyOf(entry.repo, entry.issue))) out.set(keyOf(entry.repo, entry.issue), entry);
    }
    return out;
  }

  const openAsks = () => store.listAsks({ limit: MAX_ASKS }).filter((ask) => !isFinished(ask.stage));

  // The bridge's last reading of the repos' open issues, every ask not started or parked, and Start work's asks.
  router.on("GET", "/api/backlog", ({ request, response }) => {
    requireSession(request);
    const at = now();
    const reading = ops.get("backlog");
    // Each stage has its own cap, so parked asks never crowd out one not started.
    const asks: BacklogAsk[] = [...store.listAsks({ stage: "queued", limit: MAX_BACKLOG_ASKS }), ...store.listAsks({ stage: "parked", limit: MAX_BACKLOG_ASKS })]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((ask) => ({
        id: ask.id,
        words: ask.words,
        short: titles.of(ask.words, undefined, at),
        stage: ask.stage,
        prs: ask.prs,
        createdAt: ask.createdAt,
        stageAt: ask.stageAt,
        ...(ask.repo ? { repo: ask.repo } : {}),
        ...(ask.issue !== undefined ? { issue: ask.issue } : {}),
        ...(ask.chat ? { chat: ask.chat } : {}),
        ...(ask.why ? { why: ask.why } : {}),
      }));
    const started = openAsks().flatMap((ask) => (ask.source?.startsWith("backlog:") ? (startOf(ask) ?? []) : []));
    const body: BacklogResponse = {
      at: reading?.at ?? null,
      stale: !reading || isStale(reading.at, BACKLOG_STALE_MS, at),
      repos: Object.fromEntries((reading?.repos ?? []).map((one) => [one.repo, { ...one, stale: isStale(one.at, BACKLOG_STALE_MS, at) }])),
      asks,
      started,
      closing: [...closing().values()].map((entry) => ({ repo: entry.repo as BacklogStart["repo"], issue: entry.issue! })),
    };
    json(response, 200, body);
  });

  router.on("GET", "/api/backlog/issue", ({ request, response, url }) => {
    requireSession(request);
    const repo = repoField.safeParse(url.searchParams.get("repo"));
    const n = url.searchParams.get("issue") ?? "";
    if (!repo.success || !/^[1-9]\d{0,9}$/.test(n)) throw new HttpError(400, "invalid issue");
    const issue = Number(n);
    const key = keyOf(repo.data, issue);
    const at = now().getTime();
    const kept = read.get(key);
    let pending = false;
    if (!kept || at - kept.got >= ISSUE_KEPT_MS) {
      for (const [one, when] of asked) if (at - when >= READ_ASKED_MS) asked.delete(one);
      if (asked.has(key)) pending = true;
      else if (asked.size < READS_ASKED_MAX) {
        const id = randomUUID();
        pending = bridge.sendEvent("issue.read", id, { id, repo: repo.data, issue });
        if (pending) asked.set(key, at);
      }
    }
    const open = openAsks().filter((ask) => ask.repo === repo.data && ask.issue === issue);
    const start = open.find((ask) => ask.source === backlogSource(repo.data, issue));
    // A close counts for the hour it keeps the issue off the list, and not once GitHub, read since, has it open again.
    const since = new Date(at - CLOSE_KEPT_MS).toISOString();
    const close = commands
      .issueWrites(repo.data, issue, 10)
      .find((entry) => entry.op === "close" && entry.at >= since && !(entry.status === "succeeded" && kept?.detail.state === "open" && kept.detail.at > entry.at));
    const body: BacklogIssueResponse = {
      detail: kept?.detail ?? null,
      pending,
      start: start ? startOf(start) : null,
      close: close ? writeState(close) : null,
      chat: open.find((ask) => ask.chat)?.chat ?? null,
    };
    json(response, 200, body);
  });

  router.on("PUT", "/api/bridge/issue", async ({ request, response }) => {
    requireBearer(request, config.bridgeTokenDigest);
    const parsed = parseRedacted(issueDetailSchema, await readJson(request, ISSUE_PUT_MAX));
    if (!parsed.success) {
      json(response, 400, { error: "invalid issue", issues: parsed.error.issues.slice(0, 20) });
      return;
    }
    bridge.seen();
    const key = keyOf(parsed.data.repo, parsed.data.number);
    read.delete(key);
    read.set(key, { detail: parsed.data, got: now().getTime() });
    asked.delete(key);
    for (const old of read.keys()) {
      if (read.size <= ISSUES_KEPT) break;
      read.delete(old);
    }
    json(response, 200, { ok: true });
  });

  router.on("POST", "/api/backlog/start", async ({ request, response }) => {
    requireSession(request);
    requireSameOrigin(request, config.origin);
    const parsed = writeSchema.safeParse(await readJson(request, BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid Start work");
    const { repo, issue, clientId } = parsed.data;
    const source = backlogSource(repo, issue);
    // From here to the writes there is no await, so a retry cannot slip in between.
    const prior = commands.getActionByClientId(`backlog-start-${clientId}`);
    if (prior) {
      if (prior.ask?.source !== source) throw new HttpError(409, CLIENT_ID_REUSED);
      const id = settle(prior);
      label(repo, issue, clientId);
      json(response, 200, { ask: id, already: false, start: startOrNull(id) });
      return;
    }
    const open = store.listAsks({ limit: MAX_ASKS }).find((ask) => ask.source === source && !isFinished(ask.stage));
    if (open) {
      label(repo, issue, clientId);
      json(response, 200, { ask: open.id, already: true, start: startOf(open) });
      return;
    }
    if (store.countAsks() >= MAX_ASKS) throw new HttpError(507, `${APP_NAME} holds at most ${MAX_ASKS} asks`);
    // The issue's title is its author's words, not yours, so neither your ask nor your line to Rivet carries it.
    const ask = askCreateSchema.parse({ id: nextAskId(store), words: `Start work on ${repoName(repo)} #${issue}`, who: "owner", source, repo, issue });
    const text = `Start work on ${repo} #${issue} (ask ${ask.id}). Brief a chat to take it. https://github.com/${repo}/issues/${issue}`;
    const at = now().toISOString();
    const { entry, message } = commands.addActionWithMessage(
      { id: randomUUID(), clientId: `backlog-start-${clientId}`, kind: "chat", request: { text, ask }, at },
      { from: "owner", text },
    );
    if (message) deps.broadcast(message);
    const id = settle(entry);
    label(repo, issue, clientId);
    json(response, 201, { ask: id, already: false, start: startOrNull(id) });
  });

  router.on("POST", "/api/backlog/close", async ({ request, response }) => {
    requireSession(request);
    requireSameOrigin(request, config.origin);
    const parsed = writeSchema.safeParse(await readJson(request, BODY_MAX));
    if (!parsed.success) throw new HttpError(400, "invalid Close");
    const { repo, issue, clientId } = parsed.data;
    const prior = commands.getActionByClientId(`backlog-close-${clientId}`);
    if (prior) {
      if (prior.kind !== "issue" || prior.repo !== repo || prior.issue !== issue || prior.op !== "close") throw new HttpError(409, CLIENT_ID_REUSED);
      json(response, 200, { close: writeState(prior) });
      return;
    }
    // One close per issue: a second tap, or the page opened again, gets the close already on its way.
    const already = closing().get(keyOf(repo, issue));
    if (already) {
      json(response, 200, { close: writeState(already) });
      return;
    }
    const { entry } = commands.addAction({ id: randomUUID(), clientId: `backlog-close-${clientId}`, kind: "issue", request: { repo, issue, op: "close", text: CLOSE_WORDS }, at: now().toISOString() });
    toBridge(entry);
    json(response, 201, { close: writeState(entry) });
  });

  /** Start work's agent:working label, made once per issue: a start that finds its ask but no label (a stop between the two, or a refused one) adds it. */
  function label(repo: BacklogStart["repo"], issue: number, clientId: string): void {
    if (commands.issueWrites(repo, issue, 50).some((entry) => entry.op === "label" && entry.status !== "failed")) return;
    const made = commands.addAction({ id: randomUUID(), clientId: `backlog-label-${clientId}`, kind: "issue", request: { repo, issue, op: "label" }, at: now().toISOString() });
    if (made.created) toBridge(made.entry);
  }

  function startOrNull(id: string): BacklogStart | null {
    const ask = store.getAsk(id);
    return ask ? startOf(ask) : null;
  }

  /** Start work's ask, made if missing, and its line sent while still queued: the bridge types an id once. */
  function settle(entry: AuditEntry): string {
    const id = ensureAsk(store, entry);
    if (!id) throw new HttpError(409, CLIENT_ID_REUSED);
    refreshWaits();
    if (entry.status === "queued") deps.toMonitor(entry);
    return id;
  }
}
