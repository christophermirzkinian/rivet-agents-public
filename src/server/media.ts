import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream";

import { attachmentName, FILE_TYPES, fileTypeOf, isAvType, isBigType, MAX_AV_BYTES, pdfFileName, type FileRef, type FileType } from "../shared/board.js";
import { IMAGE_TYPES, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_MEDIA_BYTES, MEDIA_SHA_PATTERN, MEDIA_TYPES, type MediaType } from "../shared/command.js";
import type { CommandStore } from "./commandstore.js";
import { HttpError, json } from "./httputil.js";
import { redactorChanges, TEXT_DOCUMENT_MAX, TEXT_DOCUMENT_TOO_BIG, textDocumentRefusal } from "./redact.js";

/**
 * 17 GB of the 20 GB volume. Past it, eviction keeps the board's files and recent uploads (below), then drops files
 * the Media tab does not record, least recently used first, and only then Media's photos and videos, oldest sent first.
 */
export const MEDIA_CAP_BYTES = 17 * 1024 * 1024 * 1024;
/**
 * A file uploaded (or re-uploaded, or served) this recently is never evicted, so a batch
 * push-board upload cannot evict its own earlier files before the board PUT names them.
 */
export const MEDIA_GRACE_MS = 15 * 60 * 1000;
const NO_ROOM = "no room for media: the board's own clips and the last 15 minutes' uploads fill the store";

const IMAGE_TOO_BIG = "The image is over 8 MB. Pick a smaller one or take a screenshot of it.";
const FILE_TOO_BIG = "The file is over 25 MB. Send a smaller one.";
const AV_TOO_BIG = "The video or sound file is over 100 MB. Send a shorter one.";
const BIG_TOO_BIG = "The file is over 100 MB. Send a smaller one.";
const AV_BUSY = "Another big file is still uploading. Send this one when it's done.";
/** Token-sent text documents read at once: each holds up to TEXT_DOCUMENT_MAX of text in memory until it ends. */
export const MAX_TEXT_UPLOADS = 4;
const TEXT_BUSY = "Other text files are still uploading. Send this one when they're done.";
/** Big uploads (BIG_TYPES) at once: the app sends one at a time, and each may hold 100 MB of disk while it streams. */
export const MAX_AV_UPLOADS = 2;
const KINDS = "photos, videos, music, PDFs, text files, Office documents, emails, ZIPs or GLB models";
const FILE_REFUSED = `That file type can't be sent. Attach ${KINDS}.`;
const FILE_MISLABELLED = `That file isn't what its name says it is. Attach ${KINDS}.`;
const EMAIL_IS_OTHER = "That email was already sent as another kind of file. Send that file again instead.";

/** Documents served as plain text, whatever they are, so nothing uploaded is ever rendered as a page. */
const TEXT_TYPES: readonly FileType[] = ["text/plain", "text/markdown", "text/csv", "application/json"];
/** What the board token may store only as the redactor would leave it: the text documents, and an email, which is text too. */
const CHECKED_TYPES: readonly string[] = [...TEXT_TYPES, "message/rfc822"];
/** Office documents: downloaded, never shown inline. */
const OFFICE_TYPES: readonly FileType[] = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
];
/** Files only ever downloaded: a browser shows none of them, and an email's HTML is never rendered. */
const DOWNLOAD_TYPES: readonly FileType[] = [...OFFICE_TYPES, "application/zip", "model/gltf-binary", "message/rfc822", "application/vnd.ms-outlook"];
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** The first box of an MP4, M4A or QuickTime file; an older .mov may open on its movie or data box. */
const MP4_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip"]);
/**
 * The major brands of a HEIC or HEIF photo's ftyp box (ISO/IEC 23008-12, editions 1 to 3), a phone
 * camera's among them. Only the first 16 bytes are kept, so the compatible brands after the major one go unread.
 */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1", "mif2", "mif3"]);

const isFileType = (type: string): type is FileType => (FILE_TYPES as readonly string[]).includes(type);

/**
 * The documents a chat message or reply names, each still stored and named again for its stored type, so a name
 * the phone sends can never give a document another type's extension.
 */
export function storedFiles(files: readonly FileRef[], typeOf: (sha: string) => FileType | null): FileRef[] {
  return files.map((file) => {
    const type = typeOf(file.sha256);
    if (!type) throw new HttpError(400, "that file is no longer on the server; attach it again");
    return { sha256: file.sha256, name: attachmentName(file.name, type) };
  });
}

/** Two requests name the same documents, in the same order, whatever their names. */
export function sameFiles(a: readonly FileRef[] | undefined, b: readonly FileRef[] | undefined): boolean {
  return JSON.stringify(a?.map((file) => file.sha256)) === JSON.stringify(b?.map((file) => file.sha256));
}

/** Whether a document's first bytes are what its type must start with; text is checked whole, as it streams. */
export function sniffFile(type: FileType, head: Buffer): boolean {
  if (type === "application/pdf") return head.toString("latin1", 0, 5) === "%PDF-";
  if (TEXT_TYPES.includes(type)) return true;
  if (type === "video/mp4" || type === "video/quicktime" || type === "audio/mp4") return MP4_BOXES.has(head.toString("latin1", 4, 8));
  if (type === "video/webm") return head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
  if (type === "audio/wav") return head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WAVE";
  // MP3 and AAC: an ID3 tag, or straight into a frame (MPEG audio's sync bits; ADTS's, layer 0).
  if (type === "audio/mpeg" || type === "audio/aac") {
    if (head.toString("latin1", 0, 3) === "ID3") return true;
    return head.length >= 2 && head[0] === 0xff && (head[1]! & (type === "audio/aac" ? 0xf6 : 0xe0)) === (type === "audio/aac" ? 0xf0 : 0xe0);
  }
  if (type === "audio/ogg") return head.toString("latin1", 0, 4) === "OggS";
  if (type === "audio/flac") return head.toString("latin1", 0, 4) === "fLaC";
  if (type === "image/heic" || type === "image/heif") return head.toString("latin1", 4, 8) === "ftyp" && HEIF_BRANDS.has(head.toString("latin1", 8, 12));
  if (type === "image/gif") return /^GIF8[79]a$/.test(head.toString("latin1", 0, 6));
  // A GLB is glTF 2.0's binary form: its magic, then version 2.
  if (type === "model/gltf-binary") return head.length >= 8 && head.toString("latin1", 0, 4) === "glTF" && head.readUInt32LE(4) === 2;
  // An .eml opens on a header field ("Received:", "From:"), or an mbox "From " line; an .msg is OLE, as below.
  if (type === "message/rfc822") return head.length >= 16 && /^(?:[A-Za-z][A-Za-z0-9_.-]*(?::|$)|From )/.test(head.toString("latin1"));
  // A ZIP is stored and handed over as it is, never unpacked here.
  if (type === "application/zip" || type.startsWith("application/vnd.openxmlformats")) return head.subarray(0, 4).equals(ZIP_MAGIC);
  return head.subarray(0, 8).equals(OLE_MAGIC);
}

/**
 * Refuses, chunk by chunk, a text document that is not UTF-8 or holds a NUL byte; `end` checks the last character is
 * whole. With `keep`, it returns the text read (the caller bounds its size); without, an empty string.
 */
function textInspector(keep = false): { chunk(buffer: Buffer): void; end(): string } {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  const refuse = (): never => {
    throw new HttpError(415, "That text file isn't plain UTF-8 text. Save it as UTF-8 text, or attach it as a PDF.");
  };
  return {
    chunk(buffer) {
      if (buffer.includes(0)) refuse();
      try {
        const read = decoder.decode(buffer, { stream: true });
        if (keep) text += read;
      } catch {
        refuse();
      }
    },
    end() {
      try {
        const read = decoder.decode();
        if (keep) text += read;
      } catch {
        refuse();
      }
      return text;
    },
  };
}

/** The first bytes each allowed type must start with, so a mislabelled upload is refused. */
export function sniffMedia(head: Buffer): MediaType | null {
  // An .m4a says so in its major brand; any other MP4 is video, sound or not.
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") return head.toString("latin1", 8, 11) === "M4A" ? "audio/mp4" : "video/mp4";
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return "video/webm";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head.toString("latin1", 0, 3) === "ID3") return "audio/mpeg";
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  if (head.length >= 5 && head.toString("latin1", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

/**
 * Content-Disposition for a document, its name re-sanitised so nothing a card or a link says can break out of the
 * header: PDFs, text, video, sound and pictures inline; Office documents, emails, ZIPs and 3D models as a download. A PDF keeps
 * a card's "document.pdf" default.
 */
export function fileDisposition(name: string, type: FileType): string {
  const safe = type === "application/pdf" ? pdfFileName(name) : attachmentName(name, type);
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${DOWNLOAD_TYPES.includes(type) ? "attachment" : "inline"}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

/** Content-Disposition for a PDF, its name re-sanitised so nothing a card says can break out of the header. */
export function pdfDisposition(name: string): string {
  return fileDisposition(name, "application/pdf");
}

/**
 * One `bytes=` range against a file of `size` bytes: null to send the whole
 * file (no header, or several ranges), "unsatisfiable" for a 416.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return header.includes(",") || !header.trim().startsWith("bytes=") ? null : "unsatisfiable";
  const [, from, to] = match as unknown as [string, string, string];
  if (from === "" && to === "") return "unsatisfiable";
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return "unsatisfiable";
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

export class MediaStore {
  private readonly dir: string;
  private avUploads = 0;
  private textUploads = 0;

  constructor(
    dataDir: string,
    private readonly store: CommandStore,
    private readonly inUse: () => Set<string>,
    private readonly capBytes = MEDIA_CAP_BYTES,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = join(dataDir, "media");
    mkdirSync(this.dir, { recursive: true });
  }

  private file(sha: string): string {
    if (!MEDIA_SHA_PATTERN.test(sha)) throw new HttpError(404, "no such media");
    return join(this.dir, sha);
  }

  /** A file eviction must keep: one the board still shows, or one used within MEDIA_GRACE_MS. */
  private held(used: Set<string>): (item: { sha: string; lastUsed: number }) => boolean {
    const since = this.now() - MEDIA_GRACE_MS;
    return (item) => used.has(item.sha) || item.lastUsed >= since;
  }

  /** Bytes an upload may use: the cap less what eviction must keep. */
  private room(): number {
    const held = this.held(this.inUse());
    let pinned = 0;
    for (const item of this.store.mediaByAge()) if (held(item)) pinned += item.size;
    return this.capBytes - pinned;
  }

  /**
   * Streams the body to disk, checking its size, type and hash before it is kept. A card's documents beyond PDFs
   * (text, Office) are checked as uploadFile checks your. A text document is named by its digest, so it is never
   * stored redacted: one the redactor would change is refused, as is one over TEXT_DOCUMENT_MAX, and so is one
   * already stored, which may predate the check or be your own. An email is checked as text. The redactor cannot read
   * a PDF, an Office document, a ZIP or a 3D model.
   */
  async upload(request: IncomingMessage, response: ServerResponse, sha: string): Promise<void> {
    const target = this.file(sha);
    const declaredType = String(request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const document = isFileType(declaredType) && !(MEDIA_TYPES as readonly string[]).includes(declaredType) ? declaredType : null;
    if (!document && !(MEDIA_TYPES as readonly string[]).includes(declaredType)) {
      throw new HttpError(415, "media must be mp4, webm, jpeg, png, mp3, m4a, pdf, or a text or Office document");
    }
    const text = document && CHECKED_TYPES.includes(document) ? textInspector(true) : null;
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > MAX_MEDIA_BYTES) throw new HttpError(413, "media is over 25 MB");
    if (text && declared > TEXT_DOCUMENT_MAX) throw new HttpError(413, TEXT_DOCUMENT_TOO_BIG);
    const held = this.store.getMedia(sha);
    if (held) {
      request.resume();
      if (CHECKED_TYPES.includes(held.type)) {
        if (held.size > TEXT_DOCUMENT_MAX) throw new HttpError(413, TEXT_DOCUMENT_TOO_BIG);
        const stored = textInspector(true);
        stored.chunk(readFileSync(target));
        const read = stored.end();
        if (redactorChanges(read)) throw new HttpError(422, textDocumentRefusal(read));
      }
      this.store.touchMedia(sha, this.now());
      json(response, 200, { sha256: sha, type: this.store.getMedia(sha)!.type, existed: true });
      return;
    }
    if (declared > this.room()) throw new HttpError(507, NO_ROOM);
    if (text && this.textUploads >= MAX_TEXT_UPLOADS) {
      // The body is left unread, so the connection cannot be reused.
      response.setHeader("connection", "close");
      throw new HttpError(429, TEXT_BUSY);
    }
    if (text) this.textUploads += 1;
    try {
      await this.receiveUpload(request, response, sha, target, declaredType, document, text);
    } finally {
      if (text) this.textUploads -= 1;
    }
  }

  private async receiveUpload(
    request: IncomingMessage,
    response: ServerResponse,
    sha: string,
    target: string,
    declaredType: string,
    document: FileType | null,
    text: ReturnType<typeof textInspector> | null,
  ): Promise<void> {
    const { size } = await this.receive(
      request,
      text ? TEXT_DOCUMENT_MAX : MAX_MEDIA_BYTES,
      text ? TEXT_DOCUMENT_TOO_BIG : "media is over 25 MB",
      (body) => {
        if (body.size === 0) throw new HttpError(400, "empty media");
        const read = text?.end();
        if (document ? !sniffFile(document, body.head) : sniffMedia(body.head) !== declaredType) throw new HttpError(415, "the file is not the type it claims");
        if (body.sha !== sha) throw new HttpError(400, "sha256 does not match the body");
        if (read !== undefined && redactorChanges(read)) throw new HttpError(422, textDocumentRefusal(read));
        if (body.size > this.room()) throw new HttpError(507, NO_ROOM);
        return target;
      },
      text ? (chunk) => text.chunk(chunk) : undefined,
    );
    this.store.putMedia(sha, document ?? (declaredType as MediaType), size, this.now());
    this.evict(sha);
    json(response, 201, { sha256: sha, type: declaredType, size });
  }

  /**
   * An image you attach. Its type comes from its first bytes only, and its
   * name is the sha256 computed here, so nothing the phone names reaches the disk.
   * Room is checked only once the hash shows the image is new: a retry of one
   * already stored is taken however full the store is.
   */
  async uploadImage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new HttpError(413, IMAGE_TOO_BIG);
    let type: MediaType | null = null;
    let existed = false;
    const { sha, size } = await this.receive(request, MAX_IMAGE_BYTES, IMAGE_TOO_BIG, (body) => {
      if (body.size === 0) throw new HttpError(400, "the image is empty");
      type = sniffMedia(body.head);
      if (!type || !(IMAGE_TYPES as readonly MediaType[]).includes(type)) throw new HttpError(415, "that file is not a JPEG or PNG image");
      if (this.store.getMedia(body.sha)) {
        existed = true;
        return null;
      }
      if (body.size > this.room()) throw new HttpError(507, "no room for images: the board's own clips fill the store");
      return this.file(body.sha);
    });
    if (existed) this.store.touchMedia(sha, this.now());
    else {
      this.store.putMedia(sha, type!, size, this.now());
      this.evict(sha);
    }
    json(response, existed ? 200 : 201, { image: sha, type, size });
  }

  /**
   * A document you attach. Its type comes from its name's extension, and its
   * content must be that type (see sniffFile; text is checked whole); the phone's
   * content-type is never read. Its name is re-derived here, and the disk name is
   * the sha256, as for an image. Room is checked as uploadImage does.
   */
  async uploadFile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const header = request.headers["x-file-name"];
    if (typeof header !== "string" || header === "") throw new HttpError(400, "the file has no name");
    let raw: string;
    try {
      raw = decodeURIComponent(header);
    } catch {
      throw new HttpError(400, "the file's name is garbled");
    }
    const type = fileTypeOf(raw);
    if (!type) throw new HttpError(415, FILE_REFUSED);
    const av = isBigType(type);
    const [maxBytes, tooBig] = av ? [MAX_AV_BYTES, isAvType(type) ? AV_TOO_BIG : BIG_TOO_BIG] : [MAX_FILE_BYTES, FILE_TOO_BIG];
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > maxBytes) throw new HttpError(413, tooBig);
    if (av && this.avUploads >= MAX_AV_UPLOADS) {
      // The body is left unread, so the connection cannot be reused.
      response.setHeader("connection", "close");
      throw new HttpError(429, AV_BUSY);
    }
    if (av) this.avUploads += 1;
    try {
      await this.receiveFile(request, response, raw, type, maxBytes, tooBig);
    } finally {
      if (av) this.avUploads -= 1;
    }
  }

  private async receiveFile(request: IncomingMessage, response: ServerResponse, raw: string, type: FileType, maxBytes: number, tooBig: string): Promise<void> {
    const text = TEXT_TYPES.includes(type) ? textInspector() : null;
    let stored: FileType = type;
    let existed = false;
    const { sha, size } = await this.receive(
      request,
      maxBytes,
      tooBig,
      (body) => {
        if (body.size === 0) throw new HttpError(400, "the file is empty");
        text?.end();
        if (!sniffFile(type, body.head)) throw new HttpError(415, FILE_MISLABELLED);
        const meta = this.store.getMedia(body.sha);
        if (meta) {
          // The same bytes under another document type (a .txt sent again as .md) keep their first type; an email is
          // only ever downloaded, so one whose bytes are already here as anything else (text, an MP3 opening on an
          // "ID3:" header) is refused rather than shown as that.
          if (!isFileType(meta.type)) throw new HttpError(415, FILE_REFUSED);
          if (type === "message/rfc822" && meta.type !== type) throw new HttpError(409, EMAIL_IS_OTHER);
          stored = meta.type;
          existed = true;
          return null;
        }
        if (body.size > this.room()) throw new HttpError(507, "no room for files: the board's own clips fill the store");
        return this.file(body.sha);
      },
      text ? (chunk) => text.chunk(chunk) : undefined,
    );
    if (existed) this.store.touchMedia(sha, this.now());
    else {
      this.store.putMedia(sha, type, size, this.now());
      this.evict(sha);
    }
    json(response, existed ? 200 : 201, { sha256: sha, name: attachmentName(raw, stored), type: stored, size });
  }

  /**
   * Streams the body to a temp file, at most `maxBytes`, then asks `keep` for the
   * path to keep it at (null drops it). The temp file never outlives the call.
   * `inspect` sees every chunk as it arrives and throws to refuse the body.
   */
  private async receive(
    request: IncomingMessage,
    maxBytes: number,
    tooBig: string,
    keep: (body: { head: Buffer; size: number; sha: string }) => string | null,
    inspect?: (chunk: Buffer) => void,
  ): Promise<{ size: number; sha: string }> {
    const temp = join(this.dir, `.upload-${randomBytes(8).toString("hex")}`);
    const hash = createHash("sha256");
    const out = createWriteStream(temp, { flags: "wx", mode: 0o600 });
    // A write error (ENOSPC, EACCES…) can come between awaits; keep it for the loop.
    let writeError: Error | null = null;
    out.on("error", (error) => {
      writeError ??= error;
    });
    const drained = () =>
      new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          out.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          out.off("drain", onDrain);
          reject(error);
        };
        out.once("drain", onDrain);
        out.once("error", onError);
      });
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      // Keep the socket alive on refusal so the HTTP handler can send the error.
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        if (writeError) throw writeError;
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > maxBytes) throw new HttpError(413, tooBig);
        if (head.length < 16) head = Buffer.concat([head, buffer.subarray(0, 16 - head.length)]);
        inspect?.(buffer);
        hash.update(buffer);
        if (!out.write(buffer)) await drained();
      }
      if (writeError) throw writeError;
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
      if (writeError) throw writeError;
      const sha = hash.digest("hex");
      const target = keep({ head, size, sha });
      if (target) renameSync(temp, target);
      else rmSync(temp, { force: true });
      return { size, sha };
    } catch (error) {
      request.pause();
      // Opening is asynchronous: wait for close before unlinking, even when the
      // first chunk is refused before the temp file has finished opening.
      if (!out.closed) await new Promise<void>((resolve) => {
        out.once("close", resolve);
        out.destroy();
      });
      rmSync(temp, { force: true });
      if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new HttpError(507, "the media volume is full");
      throw error;
    }
  }

  /**
   * Drops files in CommandStore.mediaByAge's order (others least recently used, then Media's oldest sent) until the
   * total is under the cap, keeping what the board shows and recent uploads.
   */
  evict(keep: string): string[] {
    let total = this.store.mediaBytes();
    if (total <= this.capBytes) return [];
    const held = this.held(this.inUse());
    const dropped: string[] = [];
    for (const item of this.store.mediaByAge()) {
      if (total <= this.capBytes) break;
      if (item.sha === keep || held(item)) continue;
      rmSync(this.file(item.sha), { force: true });
      this.store.deleteMedia(item.sha);
      total -= item.size;
      dropped.push(item.sha);
    }
    return dropped;
  }

  /** Serves an image only; clips and sounds are a 404 here. */
  serveImage(request: IncomingMessage, response: ServerResponse, sha: string): void {
    this.file(sha);
    const meta = this.store.getMedia(sha);
    if (!meta || !(IMAGE_TYPES as readonly string[]).includes(meta.type)) throw new HttpError(404, "no such image");
    this.serve(request, response, sha);
  }

  /** Serves a video only, for the What's Cooking poster; images, sounds and documents are a 404 here. */
  serveVideo(request: IncomingMessage, response: ServerResponse, sha: string): void {
    this.file(sha);
    const meta = this.store.getMedia(sha);
    if (!meta || (meta.type !== "video/mp4" && meta.type !== "video/webm")) throw new HttpError(404, "no such video");
    this.serve(request, response, sha);
  }

  /** Serves an image or a document only; clips and sounds are a 404 here. */
  serveAttachment(request: IncomingMessage, response: ServerResponse, sha: string): void {
    this.file(sha);
    const meta = this.store.getMedia(sha);
    if (!meta || !((IMAGE_TYPES as readonly string[]).includes(meta.type) || isFileType(meta.type))) throw new HttpError(404, "no such attachment");
    this.serve(request, response, sha);
  }

  /**
   * Opens the file before answering, so an eviction racing the request is a 404,
   * and one that lands mid-stream cannot pull the file from under an open handle.
   * A document goes out under `name` (a card's or a link's name for it), sandboxed
   * and never sniffed, so a hostile one opened on its own runs no script against
   * the app; text of any kind goes out as plain text, never as a page.
   */
  serve(request: IncomingMessage, response: ServerResponse, sha: string, name = ""): void {
    const path = this.file(sha);
    const meta = this.store.getMedia(sha);
    if (!meta) throw new HttpError(404, "no such media");
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      throw new HttpError(404, "no such media");
    }
    let size: number;
    try {
      size = fstatSync(fd).size;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    this.store.touchMedia(sha, this.now());
    const headers = {
      "content-type": TEXT_TYPES.includes(meta.type as FileType) ? "text/plain; charset=utf-8" : meta.type,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=31536000, immutable",
      etag: `"${sha}"`,
      ...(isFileType(meta.type)
        ? {
            "content-disposition": fileDisposition(name, meta.type),
            // A video or sound file opened on its own tab plays in the browser's player, which loads it again as media
            // with the session cookie; a sandboxed page's opaque origin would send it without. Its type is one the
            // upload sniffed, never a page, and nosniff keeps it that way.
            "content-security-policy": isAvType(meta.type)
              ? "default-src 'none'; media-src 'self'; frame-ancestors 'none'"
              : "sandbox; default-src 'none'; frame-ancestors 'none'",
            "x-content-type-options": "nosniff",
          }
        : {}),
    };
    const range = parseRange(request.headers.range, size);
    if (range === "unsatisfiable") {
      closeSync(fd);
      response.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
      response.end();
      return;
    }
    if (!range) response.writeHead(200, { ...headers, "content-length": size });
    else
      response.writeHead(206, {
        ...headers,
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "content-length": range.end - range.start + 1,
      });
    // A read error after the headers can only cut the response short; pipeline
    // destroys both ends and closes the file instead of throwing.
    const source = createReadStream(path, { fd, autoClose: true, ...(range ? { start: range.start, end: range.end } : {}) });
    pipeline(source, response, () => {});
  }
}
