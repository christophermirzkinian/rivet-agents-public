import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import "../web/public/sw-logic.js";
import { FILE_TYPES } from "../src/shared/board.js";
import { lostNotice, SHARE_CACHE, SHARE_META, SHARE_ORPHAN_MS, SHARE_TAKEN, shareFileKey, shareName, shareText, takeShare } from "../web/src/share-target.js";

const share = (
  globalThis as unknown as {
    rivetShare: {
      SHARE_PATH: string;
      SHARE_CACHE: string;
      SHARE_META: string;
      SHARE_TAKEN: string;
      shareFileKey(id: string, index: number): string;
      stashShare(form: FormData, cache: Cache, id: string): Promise<void>;
      receiveShare(request: Request, caches: CacheStorage, origin: string): Promise<Response>;
    };
  }
).rivetShare;

/** The Cache API, as much of it as the share target uses, in memory. */
function fakeCaches(): CacheStorage & { stores: Map<string, Map<string, Response>> } {
  const stores = new Map<string, Map<string, Response>>();
  // One Cache object per store, as a test that swaps a method on it expects.
  const opened = new Map<Map<string, Response>, Cache>();
  const cache = (store: Map<string, Response>) => {
    if (!opened.has(store)) opened.set(store, make(store));
    return opened.get(store)!;
  };
  const make = (store: Map<string, Response>) =>
    ({
      keys: async () => [...store.keys()],
      delete: async (key: string) => store.delete(key),
      put: async (key: string, response: Response) => void store.set(key, response),
      match: async (key: string) => store.get(key)?.clone(),
    }) as unknown as Cache;
  return {
    stores,
    has: async (name: string) => stores.has(name),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return cache(stores.get(name)!);
    },
    delete: async (name: string) => stores.delete(name),
  } as unknown as CacheStorage & { stores: Map<string, Map<string, Response>> };
}

function sharePost(fields: Record<string, string>, files: File[]): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const file of files) form.append("files", file);
  return new Request("https://rivet.example/share-target", { method: "POST", body: form });
}

const MP3 = new File([new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3])], "Demo theme.mp3", { type: "audio/mpeg" });
const PHOTO = new File([new Uint8Array([0xff, 0xd8, 0xff, 9])], "IMG-20261006-0001.jpg", { type: "image/jpeg" });

describe("the service worker's share target", () => {
  const ORIGIN = "https://rivet.example";
  const keys = (caches: ReturnType<typeof fakeCaches>) => [...caches.stores.get(SHARE_CACHE)!.keys()].sort();
  const form = (text: string, files: File[] = []) => {
    const data = new FormData();
    data.append("text", text);
    for (const file of files) data.append("files", file);
    return data;
  };

  it("keeps the shared files and text, then sends the app to the chat", async () => {
    const caches = fakeCaches();
    const response = await share.receiveShare(sharePost({ title: "", text: "From message: the new song", url: "" }, [MP3, PHOTO]), caches, ORIGIN);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/?tab=chat`);
    const id = (JSON.parse(await caches.stores.get(SHARE_CACHE)!.get(SHARE_META)!.clone().text()) as { id: string }).id;
    expect(id).toMatch(/^\d{13}-/);
    expect(keys(caches)).toEqual([SHARE_META, shareFileKey(id, 0), shareFileKey(id, 1)].sort());

    const taken = await takeShare(caches);
    expect(taken!.text).toBe("From message: the new song");
    expect(taken!.files.map((file) => [file.name, file.type, file.size])).toEqual([
      ["Demo theme.mp3", "audio/mpeg", MP3.size],
      ["IMG-20261006-0001.jpg", "image/jpeg", PHOTO.size],
    ]);
    expect(new Uint8Array(await taken!.files[0]!.arrayBuffer())).toEqual(new Uint8Array(await MP3.arrayBuffer()));
    expect(taken!.lost).toEqual([]);
    // Taken once: its files are gone and its meta is marked taken, so it never lands twice.
    expect(keys(caches)).toEqual([SHARE_META, SHARE_TAKEN].sort());
    expect(await takeShare(caches)).toBeNull();
  });

  it("keeps text alone, and a newer share replaces one never opened", async () => {
    const caches = fakeCaches();
    await share.receiveShare(sharePost({ text: "first" }, [PHOTO]), caches, ORIGIN);
    await share.receiveShare(sharePost({ title: "Photo Album", text: "", url: "https://example.com/album" }, []), caches, ORIGIN);
    expect(await takeShare(caches)).toEqual({ text: "Photo Album\nhttps://example.com/album", files: [], lost: [] });
  });

  it("clears files a newer share left behind once they are an hour old, never a share still being stored", async () => {
    const caches = fakeCaches();
    const cache = await caches.open(SHARE_CACHE);
    const now = Date.now();
    await cache.put(shareFileKey(`${now - SHARE_ORPHAN_MS - 1}-old`, 0), new Response(PHOTO));
    await cache.put(shareFileKey(`${now - 1000}-storing`, 0), new Response(MP3));
    await share.stashShare(form("newest"), cache, `${now}-new`);
    expect((await takeShare(caches, now))!.text).toBe("newest");
    expect(keys(caches)).toEqual([SHARE_META, SHARE_TAKEN, shareFileKey(`${now - 1000}-storing`, 0)].sort());
  });

  it("names a file the storage refused, so the composer can say it did not arrive", async () => {
    const caches = fakeCaches();
    const cache = await caches.open(SHARE_CACHE);
    const put = cache.put.bind(cache);
    cache.put = async (key: RequestInfo | URL, response: Response) => {
      if (String(key).includes("/file/0")) throw new DOMException("full", "QuotaExceededError");
      return put(key, response);
    };
    await share.stashShare(form("two files", [MP3, PHOTO]), cache, "s1");
    const taken = await takeShare(caches);
    expect(taken!.files.map((file) => file.name)).toEqual(["IMG-20261006-0001.jpg"]);
    expect(taken!.lost).toEqual(["Demo theme.mp3"]);
    expect(lostNotice(taken!.lost)).toBe("Demo theme.mp3 didn't come through from the share. Share again, or attach with the paper clip.");
    expect(lostNotice(["a.mp3", "b.pdf"])).toBe("2 files didn't come through from the share. Share again, or attach with the paper clip.");
  });

  it("gives its files back when the meta does not fit, and still says they did not arrive", async () => {
    const caches = fakeCaches();
    const cache = await caches.open(SHARE_CACHE);
    const put = cache.put.bind(cache);
    let refused = false;
    cache.put = async (key: RequestInfo | URL, response: Response) => {
      if (String(key) === SHARE_META && !refused) {
        refused = true;
        throw new DOMException("full", "QuotaExceededError");
      }
      return put(key, response);
    };
    await share.stashShare(form("caption", [MP3, PHOTO]), cache, "s2");
    expect(refused).toBe(true);
    expect(keys(caches)).toEqual([SHARE_META]);
    expect(await takeShare(caches)).toEqual({ text: "caption", files: [], lost: ["Demo theme.mp3", "IMG-20261006-0001.jpg"] });
  });

  it("leaves a share still being stored, and one stored while an older is read, for their own page", async () => {
    const caches = fakeCaches();
    const cache = await caches.open(SHARE_CACHE);
    // Files written, meta not yet: nothing is taken and nothing is deleted.
    const half = shareFileKey(`${Date.now()}-half`, 0);
    await cache.put(half, new Response(PHOTO));
    expect(await takeShare(caches)).toBeNull();
    expect(keys(caches)).toEqual([half]);

    // Share A (two files) is read; share B lands while A's first file is read, and again just before A is marked taken.
    await share.stashShare(form("A", [PHOTO, MP3]), cache, `${Date.now()}-a`);
    const match = cache.match.bind(cache);
    const put = cache.put.bind(cache);
    let firstLanded = false;
    cache.match = async (key: RequestInfo | URL) => {
      const answer = await match(key);
      if (!firstLanded && String(key).endsWith("-a/file/0")) {
        firstLanded = true;
        await share.stashShare(form("B", [MP3]), cache, `${Date.now()}-b`);
      }
      return answer;
    };
    let secondLanded = false;
    cache.put = async (key: RequestInfo | URL, response: Response) => {
      if (!secondLanded && String(key) === SHARE_TAKEN) {
        secondLanded = true;
        await share.stashShare(form("C", [PHOTO]), cache, `${Date.now()}-c`);
      }
      return put(key, response);
    };
    const a = await takeShare(caches);
    expect([firstLanded, secondLanded]).toEqual([true, true]);
    expect(a!.text).toBe("A");
    expect(a!.files.map((file) => file.name)).toEqual(["IMG-20261006-0001.jpg", "Demo theme.mp3"]);
    // C, the newest, still lands whole for its own page.
    const c = await takeShare(caches);
    expect(c!.text).toBe("C");
    expect(c!.files.map((file) => file.name)).toEqual(["IMG-20261006-0001.jpg"]);
  });

  it("still opens the chat when the post cannot be read", async () => {
    const caches = fakeCaches();
    const broken = new Request(`${ORIGIN}/share-target`, { method: "POST", body: "not a form", headers: { "content-type": "multipart/form-data; boundary=x" } });
    const response = await share.receiveShare(broken, caches, ORIGIN);
    expect(response.status).toBe(303);
    expect(await takeShare(caches)).toBeNull();
  });

  it("finds nothing waiting without making the cache, and with no Cache API at all", async () => {
    const caches = fakeCaches();
    expect(await takeShare(caches)).toBeNull();
    expect(caches.stores.size).toBe(0);
    expect(await takeShare(undefined)).toBeNull();
  });

  it("names its cache and keys as the app reads them", () => {
    expect([share.SHARE_CACHE, share.SHARE_META, share.SHARE_TAKEN, share.shareFileKey("x", 3)]).toEqual([SHARE_CACHE, SHARE_META, SHARE_TAKEN, shareFileKey("x", 3)]);
  });
});

describe("the manifest's share target", () => {
  const manifest = JSON.parse(readFileSync(new URL("../web/public/manifest.webmanifest", import.meta.url), "utf8")) as {
    share_target: { action: string; method: string; enctype: string; params: { files: { name: string; accept: string[] }[] } };
  };

  it("posts the form to the path the service worker answers", () => {
    expect(manifest.share_target).toMatchObject({ action: share.SHARE_PATH, method: "POST", enctype: "multipart/form-data" });
    expect(manifest.share_target.params.files.map((file) => file.name)).toEqual(["files"]);
  });

  it("offers the app for every type the paper clip takes", () => {
    // The app sorts and refuses as the paper clip does (sortPick), so the menu only has to cover each type.
    const accept = manifest.share_target.params.files[0]!.accept;
    for (const type of ["image/jpeg", ...FILE_TYPES]) expect(accept.some((pattern) => pattern === type || (pattern.endsWith("/*") && type.startsWith(pattern.slice(0, -1))))).toBe(true);
  });
});

describe("shareText", () => {
  it("adds the title and link only where the text does not carry them", () => {
    expect(shareText({ text: "Look https://x.test/a", url: "https://x.test/a", title: "Look" })).toBe("Look https://x.test/a");
    expect(shareText({ title: "A page", text: "", url: "https://x.test/b" })).toBe("A page\nhttps://x.test/b");
    expect(shareText({ text: "  hi  " })).toBe("hi");
    expect(shareText({ text: 5, title: null })).toBe("");
  });
});

describe("shareName", () => {
  it("gives a bare name the extension its type says", () => {
    expect(shareName("voice", "audio/mpeg")).toBe("voice.mp3");
    expect(shareName("", "application/pdf")).toBe("shared.pdf");
    expect(shareName("Fwd Logo", "message/rfc822")).toBe("Fwd Logo.eml");
    expect(shareName("song.mp3", "audio/mpeg")).toBe("song.mp3");
    expect(shareName("", "image/jpeg")).toBe("shared");
    expect(shareName("animation", "image/gif")).toBe("animation.gif");
    expect(shareName("IMG_0001.JPG", "image/heic")).toBe("IMG_0001.JPG");
    expect(shareName("archive.zip", "application/zip")).toBe("archive.zip");
  });
});
