// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CardFile } from "../src/shared/board.js";
import { cardMedia, stopCardMedia } from "../web/src/views/card-media.js";
import { fetchDocument, previewKind } from "../web/src/views/documents.js";
import { closeLightbox } from "../web/src/views/lightbox.js";
import { shareAs } from "../web/src/views/share.js";

// The page's Markdown worker, run in-line: the test DOM has no workers.
vi.mock("../web/src/views/markdown.worker.ts?worker", async () => {
  const { lexer } = await import("marked");
  return {
    default: class {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage(source: string) {
        queueMicrotask(() => this.onmessage?.({ data: lexer(source) }));
      }
      terminate() {}
    },
  };
});

// Which documents the app's own viewer shows, and a card of them: Open for the ones it can show, a plain tile saying
// so for the rest, Download on each and Share on each a phone's share sheet takes.

const SHA = { md: "1".repeat(64), log: "2".repeat(64), json: "3".repeat(64), xlsx: "4".repeat(64) };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const BODIES: Record<string, [string, string]> = {
  [SHA.md]: ["# Run notes\n\n| Job | Runs |\n|-|-:|\n| nightly | 412 |\n\n```\nnode report.mjs\n```\n", "text/plain; charset=utf-8"],
  [SHA.log]: ["23:00 nightly run finished\n", "text/plain; charset=utf-8"],
  [SHA.json]: ['{"runs":412}', "text/plain; charset=utf-8"],
  [SHA.xlsx]: ["PK\u0003\u0004", XLSX],
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = "";
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const body = BODIES[String(input).slice("/media/".length)];
      return Promise.resolve(body ? new Response(body[0], { headers: { "content-type": body[1] } }) : new Response("{}", { status: 404 }));
    }),
  );
  vi.spyOn(history, "back").mockImplementation(() => window.dispatchEvent(new PopStateEvent("popstate")));
});

afterEach(() => {
  vi.useRealTimers();
  for (const name of ["share", "canShare"]) Reflect.deleteProperty(navigator, name);
  closeLightbox();
  stopCardMedia(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("previewKind", () => {
  it("shows PDFs, Markdown, plain text, CSV and JSON, and nothing else", () => {
    expect(previewKind("application/pdf")).toBe("pdf");
    expect(previewKind("text/markdown")).toBe("markdown");
    for (const type of ["text/plain", "text/csv", "application/json"]) expect(previewKind(type)).toBe("text");
    for (const type of [XLSX, "application/msword", "application/zip", "text/html", "image/png"]) expect(previewKind(type)).toBeNull();
  });
});

describe("fetchDocument", () => {
  it("takes a text file the server sends as plain text, under its own type", async () => {
    const file = await fetchDocument(`/media/${SHA.json}`, "summary.json", "application/json");
    expect(file).toBeInstanceOf(File);
    expect((file as File).type).toBe("application/json");
    expect(await (file as File).text()).toBe('{"runs":412}');
  });

  it("says why it could not, naming a file rather than a PDF", async () => {
    expect(await fetchDocument(`/media/${"9".repeat(64)}`, "gone.md", "text/markdown")).toBe("That file is no longer on the server.");
    expect(await fetchDocument(`/media/${SHA.log}`, "sheet.xlsx", XLSX)).toBe("That file is not what its name says.");
    expect(await fetchDocument(`/media/${SHA.log}`, "a.pdf", "application/pdf")).toBe("That file is not a PDF.");
  });
});

describe("a card's documents", () => {
  const card = () => {
    const block = cardMedia("notes", {
      kind: "files",
      files: [
        { sha256: SHA.md, type: "text/markdown", name: "Run notes.md", bytes: 900 },
        { sha256: SHA.log, type: "text/plain", name: "bot-run.log", bytes: 40_000 },
        { sha256: SHA.json, type: "application/json", name: "summary.json", bytes: 300 },
        { sha256: SHA.xlsx, type: XLSX, name: "Budget.xlsx", bytes: 18_000 },
      ],
    })!;
    document.body.append(block);
    return block;
  };
  const tiles = (block: HTMLElement) => [...block.querySelectorAll<HTMLElement>(".media-file")];

  it("opens the ones the viewer shows and says so for the rest; Download and Share live in the viewer, not on the card", () => {
    const block = card();
    expect(tiles(block).map((tile) => [tile.tagName, tile.querySelector(".media-file-action")!.textContent])).toEqual([
      ["BUTTON", "Open MD"],
      ["BUTTON", "Open LOG"],
      ["BUTTON", "Open JSON"],
      ["BUTTON", "Download XLSX"],
    ]);
    // one Share per card (card-share.ts), so no Download or Share on each file; a file the viewer cannot
    // show downloads from its own row instead.
    expect(block.querySelector(".media-download, .media-share")).toBeNull();
    const opened: unknown[] = [];
    const open = window.open;
    window.open = ((url: unknown) => (opened.push(url), null)) as typeof window.open;
    tiles(block)[3]!.click();
    window.open = open;
    expect(document.querySelector(".lightbox")).toBeNull();
    expect(opened).toHaveLength(1);
    expect(String(opened[0])).toMatch(/^\/media\//);
  });

  it("formats Markdown, with its table and code block, in the viewer", async () => {
    tiles(card())[0]!.click();
    expect(document.querySelector(".lightbox-title")!.textContent).toBe("Run notes.md");
    expect(document.querySelector(".lightbox-note")!.textContent).toBe("Getting the file…");
    await vi.waitFor(() => expect(document.querySelector(".lightbox-text.markdown")).not.toBeNull());
    expect(document.querySelector(".lightbox-text h1")!.textContent).toBe("Run notes");
    expect([...document.querySelectorAll(".lightbox-text td")].map((td) => td.textContent)).toEqual(["nightly", "412"]);
    expect(document.querySelector(".lightbox-text pre code")!.textContent).toBe("node report.mjs");
    expect(document.querySelector<HTMLElement>(".lightbox-note")!.hidden).toBe(true);
  });

  it("lays out JSON and shows a log as it is", async () => {
    const block = card();
    tiles(block)[2]!.click();
    await vi.waitFor(() => expect(document.querySelector(".lightbox-plain")).not.toBeNull());
    expect(document.querySelector(".lightbox-plain")!.textContent).toBe('{\n  "runs": 412\n}');
    closeLightbox();
    await settle();
    tiles(block)[1]!.click();
    await vi.waitFor(() => expect(document.querySelector(".lightbox-plain")).not.toBeNull());
    expect(document.querySelector(".lightbox-plain")!.textContent).toBe("23:00 nightly run finished\n");
  });
});

describe("shareAs", () => {
  it("keeps what Chrome on Android shares, sends text documents as .txt, and refuses the rest", () => {
    expect(shareAs("Report.pdf", "application/pdf")).toEqual({ name: "Report.pdf", type: "application/pdf" });
    expect(shareAs("notes.txt", "text/plain")).toEqual({ name: "notes.txt", type: "text/plain" });
    expect(shareAs("Workbench prompt (locked-down laptop).md", "text/markdown")).toEqual({ name: "Workbench prompt (locked-down laptop).txt", type: "text/plain" });
    expect(shareAs("bot-run.log", "text/plain")).toEqual({ name: "bot-run.txt", type: "text/plain" });
    expect(shareAs("summary.json", "application/json")).toEqual({ name: "summary.txt", type: "text/plain" });
    expect(shareAs("voice.m4a", "audio/mp4")).toEqual({ name: "voice.m4a", type: "audio/x-m4a" });
    expect(shareAs("banner-after.mp4", "video/mp4")).toEqual({ name: "banner-after.mp4", type: "video/mp4" });
    expect(shareAs("Run..notes.md", "text/markdown")).toEqual({ name: "Run.notes.txt", type: "text/plain" });
    expect(shareAs("Q3...report.pdf", "application/pdf")).toEqual({ name: "Q3.report.pdf", type: "application/pdf" });
    expect(shareAs("Budget.xlsx", XLSX)).toBeNull();
    expect(shareAs("take.mov", "video/quicktime")).toBeNull();
  });
});

/** URL.createObjectURL and every link click: what Download saved, under which name. */
function watchSaves(): { name: string; file: Blob }[] {
  const saved: { name: string; file: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const link = `blob:test/${blobs.size}`;
    blobs.set(link, blob as Blob);
    return link;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.getAttribute("download")!, file: blobs.get(this.getAttribute("href")!)! });
  });
  return saved;
}

/** Chrome on Android's share(): files whose extension or type is off its list fail with NotAllowedError. */
function androidShare(): ShareData[] {
  const shared: ShareData[] = [];
  const ok = (file: File) => /\.(txt|pdf|csv|png|jpe?g|mp4|webm|mp3)$/i.test(file.name) && ["text/plain", "text/csv", "application/pdf", "image/png", "image/jpeg", "video/mp4", "video/webm", "audio/mpeg"].includes(file.type);
  Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true, writable: true });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    writable: true,
    value: (data: ShareData) => {
      if (!(data.files ?? []).every(ok)) return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      shared.push(data);
      return Promise.resolve();
    },
  });
  return shared;
}

describe("downloading a card's document", () => {
  const card = (file: CardFile = { sha256: SHA.md, type: "text/markdown", name: "Run notes.md", bytes: 900 }) => {
    const block = cardMedia("notes", { kind: "files", files: [file] })!;
    document.body.append(block);
    return block;
  };

  it("has Download and Share in the viewer, from the download the viewer made", async () => {
    const saved = watchSaves();
    const shared = androidShare();
    card().querySelector<HTMLButtonElement>(".media-file")!.click();
    await vi.waitFor(() => expect(document.querySelector(".lightbox-text.markdown")).not.toBeNull());
    expect([...document.querySelectorAll(".lightbox-bar :is(.media-download, .media-share)")].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Download Run notes.md",
      "Share Run notes.md",
    ]);
    document.querySelector<HTMLButtonElement>(".lightbox-bar .media-download")!.click();
    expect(saved.map((save) => save.name)).toEqual(["Run notes.md"]);
    document.querySelector<HTMLButtonElement>(".lightbox-bar .media-share")!.click();
    await vi.waitFor(() => expect(shared).toHaveLength(1));
    expect(shared[0]!.files!.map((file) => file.name)).toEqual(["Run notes.txt"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("before and after pictures", () => {
  it("open full screen like a still, under their own label", () => {
    const block = cardMedia("glow", { kind: "before-after", before: { sha256: SHA.md, type: "image/png" }, after: { sha256: SHA.log, type: "image/jpeg" } })!;
    document.body.append(block);
    const pictures = [...block.querySelectorAll<HTMLImageElement>(".media-panes img")];
    expect(pictures).toHaveLength(2);
    pictures[1]!.click();
    expect(document.querySelector(".lightbox-img")!.getAttribute("src")).toBe(`/media/${SHA.log}`);
    expect(document.querySelector(".lightbox-title")!.textContent).toBe("After");
  });
});
