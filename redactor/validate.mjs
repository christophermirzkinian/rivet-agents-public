import { defaultRepo, isRepo } from "../src/shared/repos.ts";

/** A board chat's repo: its own when it names one, else the default (src/shared/board.ts chatRepo). @param {any} chat */
export function chatRepoOf(chat) {
  return isRepo(chat?.repo) ? chat.repo : (defaultRepo() ?? undefined);
}

/**
 * A Coming row's repo is its chat's, read exactly as the server's comingChatRepo (src/shared/board.ts): the chats so
 * named holding the row's PR, else all so named; `report-page` for `report-page-73` when no chat has that name, and both
 * that chat's repo and the default when it does not hold the PR. A malformed repo is the default. Undefined is
 * the default repo (no chat, or none of that name); null is two repos, so none is guessed.
 * @param {unknown} chats the board's chats @param {unknown} name the row's chat @param {unknown} pr the row's PR
 * @returns {string | undefined | null}
 */
export function comingChatRepo(chats, name, pr) {
  if (typeof name !== "string" || !name) return undefined;
  const all = Array.isArray(chats) ? chats : [];
  const number = Number.isSafeInteger(pr) ? pr : undefined;
  const holds = (/** @type {any} */ chat) => number !== undefined && Array.isArray(chat?.prs) && chat.prs.includes(number);
  const exact = all.filter((chat) => chat?.name === name);
  const base = name.replace(/-\d+$/, "");
  const bases = exact.length || base === name ? [] : all.filter((chat) => chat?.name === base);
  /** @type {Set<string>} */
  let repos;
  if (bases.length && number !== undefined && !bases.some(holds)) repos = new Set([...bases.map(chatRepoOf), defaultRepo() ?? undefined]);
  else {
    const named = exact.length ? exact : bases;
    const holding = named.filter(holds);
    repos = new Set((holding.length ? holding : named).map(chatRepoOf));
  }
  return repos.size > 1 ? null : [...repos][0];
}

export const DECISIONS = Object.freeze(["approve", "reject", "choice", "comment", "done", "seen", "dismiss"]);

export const MAX_TEXT = 4000;
export const MAX_CHOICE = 200;
/** The server's option detail bound (src/shared/board.ts). */
export const MAX_CHOICE_DETAIL = 1000;
export const MAX_TITLE = 2000;
/** The server's MAX_STEPS and MAX_STEP (src/shared/board.ts): a todo card's steps. */
export const MAX_STEPS = 12;
export const MAX_STEP = 300;

const ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REV_RE = /^[0-9a-f]{16}$/;
const IMAGE_RE = /^[0-9a-f]{64}$/;
/** The server's MAX_CHAT_FILES: documents in one chat message, chat window or reply. */
export const MAX_CHAT_FILES = 5;
/** The server's MAX_CHAT_IMAGES: photos in one chat message, chat window or reply. */
export const MAX_CHAT_IMAGES = 10;
/** The server's ATTACHMENT_NAME_PATTERN (src/shared/board.ts): a name attachmentName gives a document. */
export const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,95}\.(?:pdf|txt|log|md|markdown|csv|json|docx|xlsx|pptx|doc|xls|ppt|mp4|mov|webm|mp3|m4a|wav|aac|ogg|opus|flac|heic|heif|gif|zip|glb|eml|msg)$/;

/**
 * @typedef {{ id: string, title: string, kind: string, ask?: string, choiceDetail?: string, steps?: string[], chat?: string, pr?: number,
 *   issue?: number, repo: string | null, risk?: string, merge?: true, headSha?: string,
 *   changes?: { replyId: string, decision: string, choice?: string } }} ReplyItem
 * @typedef {{ sha256: string, name: string }} FileRef
 * @typedef {{ id: string, itemId: string, decision: "approve"|"reject"|"choice"|"comment"|"done"|"seen"|"dismiss",
 *   choice?: string, text?: string, image?: string, images?: string[], files?: FileRef[], at?: string, rev?: string,
 *   item: ReplyItem }} Reply
 * @typedef {{ ok: true, reply: Reply } | { ok: false, id: string, reason: string }} Validated
 */

/** @param {unknown} v */
export function isId(v) {
  return typeof v === "string" && ID_RE.test(v) && !/^\.+$/.test(v);
}

/** @param {unknown} v */
export function isChatName(v) {
  return isId(v);
}

/** The sha256 name of an image the owner attached. @param {unknown} v */
export function isImageId(v) {
  return typeof v === "string" && IMAGE_RE.test(v);
}

/**
 * Documents the owner attached: 1 to MAX_CHAT_FILES refs, each a sha256 and a safe name, no sha twice. Only the two
 * fields go on; null for anything else.
 * @param {unknown} v
 * @returns {FileRef[] | null}
 */
export function validFiles(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_CHAT_FILES) return null;
  /** @type {FileRef[]} */
  const files = [];
  for (const ref of v) {
    if (!isRecord(ref) || Object.keys(ref).length !== 2 || !isImageId(ref.sha256)) return null;
    if (typeof ref.name !== "string" || !FILE_NAME_RE.test(ref.name)) return null;
    files.push({ sha256: /** @type {string} */ (ref.sha256), name: ref.name });
  }
  return new Set(files.map((file) => file.sha256)).size === files.length ? files : null;
}

/** @param {unknown} v */
function isPositiveInt(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** @param {unknown} v */
function absent(v) {
  return v === undefined || v === null;
}

/** @param {unknown} v */
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates one reply from the SSE stream. The result carries only the fields the
 * bridge acts on; `reason` never contains reply content.
 * @param {unknown} raw
 * @returns {Validated}
 */
export function validateReply(raw) {
  if (!isRecord(raw)) return { ok: false, id: "?", reason: "not-an-object" };
  const id = isId(raw.id) ? /** @type {string} */ (raw.id) : "?";
  /** @param {string} reason @returns {Validated} */
  const bad = (reason) => ({ ok: false, id, reason });
  if (id === "?") return bad("bad-id");
  if (!isId(raw.itemId)) return bad("bad-itemId");
  const itemId = /** @type {string} */ (raw.itemId);
  const decision = raw.decision;
  if (typeof decision !== "string" || !DECISIONS.includes(decision)) return bad("bad-decision");

  let choice;
  if (!absent(raw.choice)) {
    if (typeof raw.choice !== "string" || raw.choice.trim() === "" || raw.choice.length > MAX_CHOICE)
      return bad("bad-choice");
    choice = raw.choice;
  }
  if (decision === "choice" && choice === undefined) return bad("choice-missing");

  let text;
  if (!absent(raw.text)) {
    if (typeof raw.text !== "string" || raw.text.length > MAX_TEXT) return bad("bad-text");
    if (raw.text.trim() !== "") text = raw.text;
  }

  let image;
  if (!absent(raw.image)) {
    if (!isImageId(raw.image)) return bad("bad-image");
    image = /** @type {string} */ (raw.image);
  }

  // Two or more photos; one comes as `image`.
  let images;
  if (!absent(raw.images)) {
    const list = raw.images;
    const valid =
      image === undefined &&
      Array.isArray(list) &&
      list.length >= 2 &&
      list.length <= MAX_CHAT_IMAGES &&
      list.every(isImageId) &&
      new Set(list).size === list.length;
    if (!valid) return bad("bad-images");
    images = /** @type {string[]} */ ([...list]);
  }

  let files;
  if (!absent(raw.files)) {
    files = validFiles(raw.files);
    if (!files) return bad("bad-files");
  }

  let at;
  if (!absent(raw.at)) {
    if (typeof raw.at !== "string" || raw.at.length > 64) return bad("bad-at");
    at = raw.at;
  }

  let rev;
  if (!absent(raw.rev) && raw.rev !== "") {
    if (typeof raw.rev !== "string" || !REV_RE.test(raw.rev)) return bad("bad-rev");
    rev = raw.rev;
  }

  const item = raw.item;
  if (!isRecord(item)) return bad("bad-item");
  if (item.id !== itemId) return bad("item-id-mismatch");

  const titleRaw = absent(item.title) ? raw.itemTitle : item.title;
  if (typeof titleRaw !== "string" || titleRaw.length > MAX_TITLE) return bad("bad-title");
  if (!absent(item.kind) && (typeof item.kind !== "string" || item.kind.length > 100))
    return bad("bad-kind");

  let ask;
  if (!absent(item.ask)) {
    if (typeof item.ask !== "string" || item.ask.length > MAX_TEXT) return bad("bad-ask");
    if (item.ask.trim() !== "") ask = item.ask;
  }
  let steps;
  if (!absent(item.steps)) {
    if (
      !Array.isArray(item.steps) ||
      item.steps.length < 1 ||
      item.steps.length > MAX_STEPS ||
      !item.steps.every((step) => typeof step === "string" && step.length <= MAX_STEP && step.trim() !== "")
    )
      return bad("bad-steps");
    steps = /** @type {string[]} */ (item.steps);
  }
  let chat;
  if (!absent(item.chat)) {
    if (!isChatName(item.chat)) return bad("bad-chat");
    chat = /** @type {string} */ (item.chat);
  }
  let pr;
  if (!absent(item.pr)) {
    if (!isPositiveInt(item.pr)) return bad("bad-pr");
    pr = /** @type {number} */ (item.pr);
  }
  let issue;
  if (!absent(item.issue)) {
    if (!isPositiveInt(item.issue)) return bad("bad-issue");
    issue = /** @type {number} */ (item.issue);
  }
  let repo = defaultRepo();
  if (!absent(item.repo)) {
    if (!isRepo(item.repo)) return bad("bad-repo");
    repo = /** @type {string} */ (item.repo);
  }
  let risk;
  if (!absent(item.risk)) {
    if (item.risk !== "money" && item.risk !== "auth" && item.risk !== "fairness") return bad("bad-risk");
    risk = item.risk;
  }
  if (!absent(item.merge) && item.merge !== true) return bad("bad-merge");
  if (!absent(item.headSha) && (typeof item.headSha !== "string" || !/^[0-9a-f]{40}$/.test(item.headSha))) return bad("bad-head");

  /** @type {ReplyItem} */
  const outItem = {
    id: itemId,
    title: titleRaw,
    kind: typeof item.kind === "string" ? item.kind : "",
    repo,
  };
  if (ask !== undefined) outItem.ask = ask;
  // Optional context from legacy records must not make an otherwise valid answer undeliverable.
  if (choice !== undefined && typeof item.choiceDetail === "string" && item.choiceDetail.trim() !== "" && item.choiceDetail.length <= MAX_CHOICE_DETAIL)
    outItem.choiceDetail = item.choiceDetail;
  if (steps !== undefined) outItem.steps = steps;
  if (chat !== undefined) outItem.chat = chat;
  if (pr !== undefined) outItem.pr = pr;
  if (issue !== undefined) outItem.issue = issue;
  if (risk !== undefined) outItem.risk = risk;
  if (item.merge === true) outItem.merge = true;
  if (typeof item.headSha === "string") outItem.headSha = item.headSha;
  // After Answer again, the earlier answer this one changes; context only, so a malformed one is left out.
  const changes = /** @type {{ replyId?: unknown, decision?: unknown, choice?: unknown } | null | undefined} */ (item.changes);
  if (changes && typeof changes === "object" && isId(changes.replyId) && typeof changes.decision === "string" && DECISIONS.includes(changes.decision))
    outItem.changes = {
      replyId: /** @type {string} */ (changes.replyId),
      decision: changes.decision,
      ...(typeof changes.choice === "string" && changes.choice.length <= 200 ? { choice: changes.choice } : {}),
    };

  /** @type {Reply} */
  const reply = {
    id,
    itemId,
    decision: /** @type {Reply["decision"]} */ (decision),
    item: outItem,
  };
  if (choice !== undefined) reply.choice = choice;
  if (text !== undefined) reply.text = text;
  if (image !== undefined) reply.image = image;
  if (images !== undefined) reply.images = images;
  if (files !== undefined) reply.files = files;
  if (at !== undefined) reply.at = at;
  if (rev !== undefined) reply.rev = rev;
  return { ok: true, reply };
}

/** The stages of a coming item, in order (src/shared/board.ts COMING_STAGES). */
export const COMING_STAGES = Object.freeze(["building", "review", "owner-ok", "merging", "deploying", "shipped"]);
export const MAX_ETA_MINUTES = 7 * 24 * 60;
/** The server's cap on PR and issue numbers (src/shared/board.ts `number`). */
const MAX_NUMBER = 1_000_000_000;

/** @param {unknown} v @param {number} max */
function isText(v, max) {
  return typeof v === "string" && v.length >= 1 && v.length <= max;
}

/**
 * What is wrong with a `coming` or `chats` entry's progress fields, one line each.
 * @param {Record<string, unknown>} item @param {string} at @param {string[]} problems
 */
function progressProblems(item, at, problems) {
  const bad = (/** @type {string} */ field, /** @type {string} */ rule) => problems.push(`${at}.${field} ${rule}`);
  if (item.what !== undefined && !isText(item.what, 200)) bad("what", "must be 1 to 200 characters");
  if (item.progress !== undefined && !(typeof item.progress === "number" && item.progress >= 0 && item.progress <= 1)) bad("progress", "must be a number from 0 to 1");
  if (item.etaMinutes !== undefined && !(Number.isSafeInteger(item.etaMinutes) && /** @type {number} */ (item.etaMinutes) >= 0 && /** @type {number} */ (item.etaMinutes) <= MAX_ETA_MINUTES))
    bad("etaMinutes", `must be whole minutes from 0 to ${MAX_ETA_MINUTES}`);
  if (item.updatedAt !== undefined && !(typeof item.updatedAt === "string" && item.updatedAt.length <= 64)) bad("updatedAt", "must be an ISO timestamp");
}

/**
 * What is wrong with a board's `coming` items and the progress fields on its `chats`, one line each, so
 * push-board can name the entry before the server refuses the whole board. Old entries without the fields pass;
 * a field is checked only when set, and a null counts as set because the server refuses it.
 * @param {unknown} board
 * @returns {string[]}
 */
export function progressFieldProblems(board) {
  if (!isRecord(board)) return [];
  /** @type {string[]} */
  const problems = [];
  if (board.coming !== undefined && !Array.isArray(board.coming)) problems.push("coming must be an array");
  else
    (board.coming ?? []).forEach((/** @type {unknown} */ item, /** @type {number} */ i) => {
      const at = `coming[${i}]`;
      if (!isRecord(item)) return problems.push(`${at} is not an object`);
      const bad = (/** @type {string} */ field, /** @type {string} */ rule) => problems.push(`${at}.${field} ${rule}`);
      if (!isText(item.title, 300)) bad("title", "must be 1 to 300 characters");
      if (item.pr !== undefined && !(isPositiveInt(item.pr) && /** @type {number} */ (item.pr) <= MAX_NUMBER)) bad("pr", "must be a PR number");
      if (item.app !== undefined && !isText(item.app, 80)) bad("app", "must be 1 to 80 characters");
      if (item.stage !== undefined && !COMING_STAGES.includes(/** @type {string} */ (item.stage))) bad("stage", `must be one of ${COMING_STAGES.join(", ")}`);
      if (item.chat !== undefined && !isChatName(item.chat)) bad("chat", "must be a chat name");
      if (item.requestedAt !== undefined && !(typeof item.requestedAt === "string" && item.requestedAt.length <= 64)) bad("requestedAt", "must be an ISO timestamp");
      progressProblems(item, at, problems);
    });
  if (Array.isArray(board.chats))
    board.chats.forEach((/** @type {unknown} */ chat, /** @type {number} */ i) => {
      if (!isRecord(chat)) return;
      const at = `chats[${i}]`;
      if (chat.stage !== undefined && !isText(chat.stage, 40)) problems.push(`${at}.stage must be 1 to 40 characters`);
      progressProblems(chat, at, problems);
    });
  return problems;
}
