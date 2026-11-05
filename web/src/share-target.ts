import { FILE_EXTENSIONS, fileTypeOf } from "../../src/shared/board.js";

// What the Share menu sent (another app's photo, song, document or words), as the service worker kept it
// (public/sw-logic.js, whose names these match; test/share-target.test.ts checks they do). It waits there through a
// signed-out start, so it is taken only once signed in.

export const SHARE_CACHE = "rivet-share";
export const SHARE_META = "/share-target/meta";
export const SHARE_TAKEN = "/share-target/taken";
/** A share's files left behind this long, never taken, are another share's to clear: none takes an hour to store. */
export const SHARE_ORPHAN_MS = 60 * 60 * 1000;
export const shareFileKey = (id: string, index: number): string => `/share-target/${id}/file/${index}`;

/** A share for the Chat composer: the words for the box, the files to attach, and the names of any that did not arrive. */
export interface Shared {
  text: string;
  files: File[];
  lost: string[];
}

interface Meta {
  id?: unknown;
  title?: unknown;
  text?: unknown;
  url?: unknown;
  files?: unknown;
}

/**
 * The share waiting, if any, taken once: the cache keeps its meta, marked taken, so no delete can race a newer share's
 * meta. Null when there is none, when it was taken already, when one is still being stored (its meta comes last), or
 * when it cannot be read.
 */
export async function takeShare(store: CacheStorage | undefined = globalThis.caches, now = Date.now()): Promise<Shared | null> {
  if (!store) return null;
  try {
    // has first: open would make the cache on every start.
    if (!(await store.has(SHARE_CACHE))) return null;
    const cache = await store.open(SHARE_CACHE);
    const response = await cache.match(SHARE_META);
    if (!response) return null;
    const meta = (await response.json()) as Meta;
    if (typeof meta.id !== "string") return null;
    const id = meta.id;
    if ((await (await cache.match(SHARE_TAKEN))?.text()) === id) return null;
    const files: File[] = [];
    const lost: string[] = [];
    const listed = Array.isArray(meta.files) ? (meta.files as { name?: unknown; type?: unknown; lost?: unknown }[]) : [];
    for (const [index, entry] of listed.entries()) {
      const type = typeof entry.type === "string" ? entry.type : "";
      const name = shareName(typeof entry.name === "string" ? entry.name : "", type);
      const body = entry.lost === true ? undefined : await cache.match(shareFileKey(id, index));
      if (body) files.push(new File([await body.blob()], name, { type }));
      else lost.push(name);
    }
    // A marker the quota refuses still lets the share land: twice at worst, never lost.
    await cache.put(SHARE_TAKEN, new Response(id)).catch(() => undefined);
    // This share's files, and any a newer share left behind long enough ago that none is still being stored.
    for (const key of await cache.keys()) {
      const path = new URL(typeof key === "string" ? key : key.url, "http://share").pathname;
      const owner = /^\/share-target\/([^/]+)\/file\//.exec(path)?.[1];
      if (owner && (owner === id || now - Number.parseInt(owner, 10) > SHARE_ORPHAN_MS)) await cache.delete(key);
    }
    const text = shareText(meta);
    return text || files.length || lost.length ? { text, files, lost } : null;
  } catch {
    return null;
  }
}

/** What the composer says of shared files that did not arrive. */
export function lostNotice(lost: readonly string[]): string | null {
  if (!lost.length) return null;
  return `${lost.length === 1 ? `${lost[0]} didn't` : `${lost.length} files didn't`} come through from the share. Share again, or attach with the paper clip.`;
}

/** The words a share brings: its text, with its title and link where the text does not already carry them. */
export function shareText(meta: Meta): string {
  const field = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const text = field(meta.text);
  const title = field(meta.title);
  const url = field(meta.url);
  return [title && !text.includes(title) ? title : "", text, url && !text.includes(url) ? url : ""].filter(Boolean).join("\n");
}

/**
 * A shared file's name with an extension the paper clip knows: some apps share a song or a document as a bare name,
 * and its type then says which extension it has.
 */
export function shareName(name: string, type: string): string {
  const base = name.trim() || "shared";
  // A bare-named GIF too: the paper clip sends a GIF as a file by its extension, so a redraw never stills it.
  if (fileTypeOf(base) || /\.(?:jpe?g|png|heic|heif|webp|gif)$/i.test(base)) return base;
  const extension = Object.keys(FILE_EXTENSIONS).find((key) => FILE_EXTENSIONS[key as keyof typeof FILE_EXTENSIONS] === type);
  return extension ? `${base}.${extension}` : base;
}
