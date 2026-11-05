import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paddedEdge, videoFrame } from "./clip-check.mjs";
import { redactorChanges, TEXT_DOCUMENT_MAX, TEXT_DOCUMENT_TOO_BIG, textDocumentRefusal } from "./redact-check.mjs";
import { sanitizeLine } from "./templates.mjs";
import { MAX_CHOICE_DETAIL } from "./validate.mjs";

// What scripts/push-board.mjs and scripts/rivet.mjs share: reading and checking card media, uploading it, and
// reading the server's answers.

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_STILLS = 8;
export const MAX_AUDIO = 6;
export const MAX_FILES = 4;
/** @type {Record<string, string>} */
export const MEDIA_TYPES = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
};

/**
 * @typedef {{ before?: string, after?: string, poster?: string, stills: string[],
 *   audio: { file: string, label?: string }[], files: string[], skipCorner?: boolean }} MediaFlags
 * @typedef {{ role: "before" | "after" | "poster" | "still" | "audio" | "file", file: string, type: string,
 *   sha256: string, bytes: Buffer, label?: string }} Clip
 */

/**
 * Reads the media flag at argv[i] into `m`: --before, --after, --poster, --still, --audio, --label, --file and
 * --skip-corner-check. Returns the index of the flag's last argument, or -1 when argv[i] is not a media flag.
 * @param {string[]} argv
 * @param {number} i
 * @param {MediaFlags} m
 */
export function mediaFlag(argv, i, m) {
  const a = argv[i];
  if (a === "--skip-corner-check") {
    m.skipCorner = true;
    return i;
  }
  if (a === "--before" || a === "--after" || a === "--poster") {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${a} needs a file`);
    m[/** @type {"before" | "after" | "poster"} */ (a.slice(2))] = value;
    return i + 1;
  }
  if (a === "--still") {
    const value = argv[i + 1];
    if (value === undefined) throw new Error("--still needs a file");
    if (!/\.(jpe?g|png)$/i.test(value)) throw new Error(`${path.basename(value)}: stills are jpg or png`);
    if (m.stills.length === MAX_STILLS) throw new Error(`at most ${MAX_STILLS} stills`);
    m.stills.push(value);
    return i + 1;
  }
  if (a === "--audio") {
    const value = argv[i + 1];
    if (value === undefined) throw new Error("--audio needs a file");
    if (!/\.(mp3|m4a)$/i.test(value)) throw new Error(`${path.basename(value)}: sound clips are mp3 or m4a`);
    if (m.audio.length === MAX_AUDIO) throw new Error(`at most ${MAX_AUDIO} sound clips`);
    m.audio.push({ file: value });
    return i + 1;
  }
  if (a === "--file") {
    const value = argv[i + 1];
    if (value === undefined) throw new Error("--file needs a file");
    if (!Object.hasOwn(DOCUMENT_TYPES, path.extname(value).toLowerCase())) {
      throw new Error(`${path.basename(value)}: --file takes a pdf, md, txt, log, csv, json, docx, xlsx, pptx, doc, xls or ppt`);
    }
    if (m.files.length === MAX_FILES) throw new Error(`at most ${MAX_FILES} documents`);
    m.files.push(value);
    return i + 1;
  }
  if (a === "--label") {
    const value = argv[i + 1];
    const last = m.audio.at(-1);
    if (value === undefined || !last || last.label !== undefined) throw new Error("--label names the --audio just before it");
    if (!value.trim() || value.length > 40) throw new Error("a label is 1 to 40 characters");
    last.label = value;
    return i + 1;
  }
  return -1;
}

/** @param {MediaFlags} m */
export function hasMedia(m) {
  return Boolean(m.before || m.after || m.stills.length || m.audio.length || m.files.length);
}

/**
 * The documents --file takes, as the server's FILE_EXTENSIONS (src/shared/board.ts) has them.
 * @type {Record<string, string>}
 */
export const DOCUMENT_TYPES = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
};

/**
 * A document's name as the card shows it: letters, digits, spaces and . _ - ( ), starting
 * with a letter or digit, ending in its extension (lower case), 96 characters of stem at most.
 * The server's pdfFileName and attachmentName (src/shared/board.ts) are the same rule.
 * @param {string} file
 */
export function documentName(file) {
  const extension = path.extname(file).toLowerCase();
  const stem = path
    .basename(file)
    .slice(0, -extension.length)
    .replace(/[^A-Za-z0-9 ._()-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 96)
    .trimEnd();
  return `${stem || (extension === ".pdf" ? "document" : "file")}${extension}`;
}

/**
 * The server's refusal as one line; with `issues`, a 400's first schema issues too.
 * @param {Response} res
 * @param {{ issues?: boolean }} [opts]
 */
export async function serverError(res, { issues = false } = {}) {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const doc = JSON.parse(text);
      detail = typeof doc?.error === "string" ? doc.error : "";
      if (issues && Array.isArray(doc?.issues) && doc.issues.length)
        detail += ` (${doc.issues
          .slice(0, 3)
          .map((/** @type {any} */ issue) => `${Array.isArray(issue?.path) ? issue.path.join(".") : "?"}: ${issue?.message ?? "invalid"}`)
          .join("; ")})`;
    } catch {}
  } catch {}
  return `http ${res.status}${detail ? `: ${sanitizeLine(detail, 200)}` : ""}`;
}

/** The text types --file takes: the server refuses one the redactor would change, or one over 256 KB. */
const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json"];

/**
 * A file read for upload. A text document is checked here, before it is hashed, as the server checks it: one the
 * redactor would change is refused, never sent redacted under another digest.
 * @param {string} file @param {Record<string, string>} [types]
 */
export function readClip(file, types = MEDIA_TYPES) {
  const type = types[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`${path.basename(file)}: only mp4, webm, jpg, png, mp3, m4a and pdf`);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a file`);
  if (stat.size === 0 || stat.size > MAX_MEDIA_BYTES) throw new Error(`${path.basename(file)}: empty or over 25 MB`);
  const bytes = fs.readFileSync(file);
  if (type === "application/pdf" && bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error(`${path.basename(file)}: not a PDF`);
  if (TEXT_TYPES.includes(type)) {
    if (bytes.length > TEXT_DOCUMENT_MAX) throw new Error(`${path.basename(file)}: ${TEXT_DOCUMENT_TOO_BIG}`);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${path.basename(file)}: not UTF-8 text`);
    }
    if (redactorChanges(text)) throw new Error(`${path.basename(file)}: ${textDocumentRefusal(text)}`);
  }
  return { type, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Reads every file the flags name, in card order, and refuses a video recorded bigger than the viewport.
 * @param {MediaFlags} m
 * @param {(msg: string) => void} warn
 * @returns {Promise<Clip[]>}
 */
export async function readMedia(m, warn) {
  /** @type {Clip[]} */
  const clips = [];
  for (const role of /** @type {const} */ (["before", "after", "poster"])) {
    const file = m[role];
    if (file === undefined) continue;
    const clip = readClip(file);
    if (clip.type.startsWith("audio/")) throw new Error(`${path.basename(file)}: --${role} is a video or image; sound goes in --audio`);
    if (clip.type === "application/pdf") throw new Error(`${path.basename(file)}: --${role} is a video or image; a PDF goes in --file`);
    clips.push({ role, file, ...clip });
  }
  for (const file of m.stills) clips.push({ role: "still", file, ...readClip(file) });
  for (const { file, label } of m.audio) clips.push({ role: "audio", file, ...readClip(file), ...(label === undefined ? {} : { label }) });
  for (const clip of clips) {
    if (m.skipCorner || !clip.type.startsWith("video/")) continue;
    const frame = await videoFrame(clip.file);
    if (!frame) {
      warn(`could not read a frame of ${path.basename(clip.file)} (is ffmpeg installed?); skipped the corner check`);
      continue;
    }
    const edge = paddedEdge(frame);
    if (edge)
      throw new Error(
        `${path.basename(clip.file)}: the page sits in the top-left corner, with grey padding along the ${edge} edge. ` +
          "Playwright's recordVideo size was bigger than the viewport; record with recordVideo.size equal to the viewport " +
          "(or the CDP screencast) and upload again. If that grey is part of the page itself, add --skip-corner-check.",
      );
  }
  for (const file of m.files) clips.push({ role: "file", file, ...readClip(file, DOCUMENT_TYPES) });
  return clips;
}

/** @param {Clip[]} clips */
export function mediaOf(clips) {
  const has = (/** @type {string} */ role) => clips.some((c) => c.role === role);
  /** @type {Record<string, unknown>} */
  const media = {
    kind:
      has("before") && has("after")
        ? "before-after"
        : has("before") || has("after")
          ? "video"
          : has("audio")
            ? "audio"
            : has("still")
              ? "stills"
              : "files",
  };
  /** @type {{ sha256: string, type: string }[]} */
  const stills = [];
  /** @type {{ sha256: string, type: string, label?: string }[]} */
  const sounds = [];
  /** @type {{ sha256: string, type: string, name: string, bytes: number }[]} */
  const files = [];
  for (const clip of clips) {
    const ref = { sha256: clip.sha256, type: clip.type };
    if (clip.role === "still") {
      if (!stills.some((s) => s.sha256 === ref.sha256)) stills.push(ref);
    } else if (clip.role === "audio") sounds.push(clip.label === undefined ? ref : { ...ref, label: clip.label });
    else if (clip.role === "file") {
      if (!files.some((f) => f.sha256 === ref.sha256)) files.push({ ...ref, name: documentName(clip.file), bytes: clip.bytes.length });
    } else media[clip.role] = ref;
  }
  if (stills.length) media.stills = stills;
  if (sounds.length) media.clips = sounds;
  if (files.length) media.files = files;
  return media;
}

/**
 * Uploads each clip to the server's media store, one request (and one 5-minute timeout) each.
 * @param {Clip[]} clips
 * @param {{ origin: string, token: string, fetch: typeof fetch, log: (msg: string) => void }} deps
 */
export async function uploadClips(clips, { origin, token, fetch: fetchFn, log }) {
  for (const clip of clips) {
    const res = await fetchFn(`${origin}/api/bridge/media/${clip.sha256}`, {
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": clip.type },
      body: clip.bytes,
    });
    if (!res.ok) throw new Error(`${clip.role} ${path.basename(clip.file)}: ${await serverError(res)}`);
    await res.body?.cancel().catch(() => {});
    log(`uploaded ${clip.role} ${clip.sha256.slice(0, 12)}`);
  }
}

/**
 * The server's record of one decision, as `--verify` prints it; null when it is not the reply asked for.
 * @param {any} doc
 * @param {string} id
 */
export function replyRecord(doc, id) {
  const r = doc?.reply ?? doc;
  if (!r || typeof r !== "object" || r.id !== id) return null;
  const item = r.item ?? {};
  const choiceDetail = typeof item.choiceDetail === "string" && item.choiceDetail.trim() !== "" && item.choiceDetail.length <= MAX_CHOICE_DETAIL
    ? item.choiceDetail : undefined;
  return {
    id: r.id,
    itemId: r.itemId,
    decision: r.decision,
    choice: r.choice,
    // The owner's whole answer, so a forged comment that drops or rewrites a
    // condition ("staging only") or rewrites the ask shows up as different
    // from the record.
    text: r.text,
    // What came with it, by hash and name, so an answer that was only photos or files still shows its content.
    image: r.image,
    images: r.images,
    files: Array.isArray(r.files) ? r.files.map((/** @type {any} */ file) => ({ name: file?.name, sha256: file?.sha256 })) : undefined,
    itemTitle: r.itemTitle,
    rev: r.rev,
    item: { ask: item.ask, choiceDetail, steps: item.steps, pr: item.pr, issue: item.issue, repo: item.repo, chat: item.chat },
    at: r.at,
    delivery: r.delivery,
  };
}
