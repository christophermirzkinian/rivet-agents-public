import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import "../web/public/sw-logic.js";

// What Android Chrome needs before it lists Rivet Agents in the share sheet (a chat app's included): an installed WebAPK whose
// manifest has a share_target Chrome's parser keeps. Chrome drops the whole share_target when one of these is off.

const pub = join(import.meta.dirname, "..", "web", "public");
const manifest = JSON.parse(readFileSync(join(pub, "manifest.webmanifest"), "utf8")) as {
  scope: string;
  start_url: string;
  display: string;
  icons: { sizes: string }[];
  share_target: { action: string; method: string; enctype: string; params: { title?: string; text?: string; url?: string; files?: { name: string; accept: string[] }[] } };
};
const share = (globalThis as unknown as { rivetShare: { SHARE_PATH: string } }).rivetShare;

describe("the share target", () => {
  it("is installable as a WebAPK: standalone, in scope, with 192 and 512 icons", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });

  it("posts multipart to a path in scope that the service worker answers", () => {
    const target = manifest.share_target;
    expect(target.method).toBe("POST");
    expect(target.enctype).toBe("multipart/form-data");
    expect(target.action.startsWith(manifest.scope)).toBe(true);
    expect(target.action).toBe(share.SHARE_PATH);
  });

  it("takes plain text (a chat app's message) as well as files", () => {
    const params = manifest.share_target.params;
    expect(params).toMatchObject({ title: "title", text: "text", url: "url" });
    expect(params.files).toHaveLength(1);
    expect(params.files![0]!.name).toBe("files");
    for (const type of params.files![0]!.accept) expect(type).toMatch(/^([a-z]+\/(\*|[a-z0-9.+-]+)|\.[a-z0-9]+)$/);
    expect(params.files![0]!.accept).toEqual(expect.arrayContaining(["image/*", "video/*", "text/*", "application/*"]));
  });
});
