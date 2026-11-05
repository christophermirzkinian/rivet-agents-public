import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isImageId } from "./validate.mjs";

// Images the owner attaches in the app ride along with a chat message or a card
// answer. The bridge downloads each one before it types the line that names it,
// so the agent gets a file on this Mac. The file is named by the sha256 in the
// event, which the download must match; nothing else from the server names it.

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGES_CAP_BYTES = 256 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 60_000;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILE_RE = /^[0-9a-f]{64}\.(?:jpg|png)$/;
/** A disk step that fails with one of these will fail again on a replay, so it is not retried. */
const LASTING_DISK_ERRORS = new Set(["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "ENOTDIR", "ELOOP"]);
/** @type {Attachment} */
const NOT_SAVED = { unavailable: "not-saved" };

/**
 * @typedef {{ path: string } | { unavailable: "gone" | "too-big" | "hash-mismatch" | "not-an-image" | "not-saved" }} Attachment
 */

/**
 * Runs a step on the images folder. A lasting filesystem error (a full,
 * read-only or unwritable disk, a link in the way) means the image is not saved,
 * and the chat is told so instead of the event replaying forever.
 * @param {() => Attachment | null} step
 * @returns {Attachment | null}
 */
function onDisk(step) {
  try {
    return step();
  } catch (err) {
    if (LASTING_DISK_ERRORS.has(/** @type {NodeJS.ErrnoException} */ (err)?.code ?? "")) return NOT_SAVED;
    throw err;
  }
}

/**
 * The images folder, created 0700 when missing. Null when it is a symlink or
 * not a directory: the image is then not saved, and that lasts.
 * @param {string} dir
 */
function openDir(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
  }
  const stat = fs.lstatSync(dir);
  return stat.isDirectory() ? stat : null;
}

/**
 * Recheck the directory after the download, before any synchronous disk changes.
 * @param {string} dir
 * @param {import("node:fs").Stats | null} original
 */
function sameDir(dir, original) {
  try {
    const stat = fs.lstatSync(dir);
    return !!original && stat.isDirectory() && stat.dev === original.dev && stat.ino === original.ino;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * The cached copy of an image: a regular file (never followed through a link)
 * whose bytes still hash to its name. Anything else under that name is removed.
 * @param {string} dir
 * @param {string} sha
 * @returns {string | null}
 */
function cached(dir, sha) {
  for (const ext of ["jpg", "png"]) {
    const file = path.join(dir, `${sha}.${ext}`);
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === "ENOENT") continue;
      // ELOOP: a symlink under the image's name.
      fs.rmSync(file, { recursive: true, force: true });
      continue;
    }
    let good = false;
    try {
      good = fs.fstatSync(fd).isFile() && createHash("sha256").update(fs.readFileSync(fd)).digest("hex") === sha;
    } finally {
      fs.closeSync(fd);
    }
    if (good) {
      const now = new Date();
      fs.utimesSync(file, now, now);
      return file;
    }
    fs.rmSync(file, { recursive: true, force: true });
  }
  return null;
}

/** @param {Buffer} head @returns {"jpg" | "png" | null} */
export function sniffImage(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG)) return "png";
  return null;
}

/** @param {string} stateFile */
export function imagesDir(stateFile) {
  return path.resolve(path.dirname(stateFile), "images");
}

/**
 * Downloads one attached image into the images folder beside the state file and
 * returns its absolute path, or why there is none to give. Throws on anything a
 * retry could fix (network, timeout, a 5xx), so the event replays; a full or
 * unwritable disk is not one of those.
 * @param {{ origin: string, token: string, fetch: typeof fetch, state: { file: string } }} deps
 * @param {string} sha
 * @returns {Promise<Attachment>}
 */
export async function fetchImage(deps, sha) {
  if (!isImageId(sha)) throw new Error("bad image id");
  const dir = imagesDir(deps.state.file);
  /** @type {import("node:fs").Stats | null} */
  let originalDir = null;
  const local = onDisk(() => {
    originalDir = openDir(dir);
    if (!originalDir) return NOT_SAVED;
    const hit = cached(dir, sha);
    return hit ? { path: hit } : null;
  });
  if (local) return local;
  const res = await deps.fetch(`${deps.origin}/api/bridge/media/${sha}`, {
    headers: { authorization: `Bearer ${deps.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return { unavailable: "gone" };
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`image http ${res.status}`);
  }
  if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) {
    await res.body.cancel().catch(() => {});
    return { unavailable: "too-big" };
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      return { unavailable: "too-big" };
    }
    chunks.push(Buffer.from(value));
  }
  const body = Buffer.concat(chunks);
  if (createHash("sha256").update(body).digest("hex") !== sha) return { unavailable: "hash-mismatch" };
  const ext = sniffImage(body);
  if (!ext) return { unavailable: "not-an-image" };
  return /** @type {Attachment} */ (
    onDisk(() => {
      if (!sameDir(dir, originalDir)) return NOT_SAVED;
      pruneImages(dir, null, IMAGES_CAP_BYTES - body.length);
      const file = path.join(dir, `${sha}.${ext}`);
      const tmp = path.join(dir, `.${sha}.${randomBytes(4).toString("hex")}.tmp`);
      try {
        fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
        fs.renameSync(tmp, file);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      return { path: file };
    })
  );
}

/**
 * Deletes the least recently used images until the folder is at or under the
 * cap, never `keep`. Only regular files named like an image it wrote count;
 * links and anything else in the folder are left alone.
 * @param {string} dir
 * @param {string | null} keep
 * @param {number} [cap]
 * @returns {string[]} the files removed
 */
export function pruneImages(dir, keep, cap = IMAGES_CAP_BYTES) {
  const files = fs
    .readdirSync(dir)
    .filter((name) => FILE_RE.test(name))
    .flatMap((name) => {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      return stat.isFile() ? [{ file, size: stat.size, used: stat.mtimeMs }] : [];
    })
    .sort((a, b) => a.used - b.used);
  let total = files.reduce((sum, entry) => sum + entry.size, 0);
  /** @type {string[]} */
  const removed = [];
  for (const entry of files) {
    if (total <= cap) break;
    if (entry.file === keep) continue;
    fs.rmSync(entry.file, { force: true });
    total -= entry.size;
    removed.push(entry.file);
  }
  return removed;
}
