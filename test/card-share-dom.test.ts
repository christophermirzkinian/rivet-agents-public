// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServedNeed } from "../src/shared/board.js";

const flashed: string[] = [];
vi.mock("../web/src/views/toast.js", async (original) => ({
  ...(await original<typeof import("../web/src/views/toast.js")>()),
  flash: (text: string) => flashed.push(text),
}));

const { cardShareButton, cardShareText } = await import("../web/src/views/card-share.js");
const { endSession } = await import("../web/src/session.js");

const BYTES = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const clip = (c: string) => ({ sha256: c.repeat(64), type: "video/mp4" as const });
const still = (c: string) => ({ sha256: c.repeat(64), type: "image/png" as const });
// Each test its own card: what a Share fetched is kept per card for the next tap.
let card = 0;
const update = (extra: Partial<ServedNeed> = {}): ServedNeed => ({
  id: `u${card}`,
  kind: "update",
  title: "Rubbish notes: step 1",
  ask: "Prototype first.\n\n• Ten notes\n• One a day",
  rev: "1".repeat(16),
  chat: "rubbish-step1",
  pr: 4205,
  links: [{ label: "PR comment", url: "https://github.com/x/y/pull/4205#issuecomment-1" }],
  ...extra,
});

let shares: ShareData[];
let sharePlan: string[];
let canShare: boolean;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  card += 1;
  flashed.length = 0;
  shares = [];
  sharePlan = [];
  canShare = true;
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: (data: ShareData) => canShare && Boolean(data.files?.length) });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: vi.fn((data: ShareData) => {
      shares.push(data);
      const outcome = sharePlan.shift();
      return outcome ? Promise.reject(new DOMException("share", outcome)) : Promise.resolve();
    }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const type = String(input).startsWith(`/media/${"c"}`) ? "image/png" : "video/mp4";
      return Promise.resolve(new Response(BYTES, { headers: { "content-type": type } }));
    }),
  );
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "canShare");
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
});

describe("Share on a card", () => {
  it("is the title, a blank line, then the text with its line breaks; no chat, PR, links or ids", () => {
    const text = cardShareText(update());
    expect(text).toBe("Rubbish notes: step 1\n\nPrototype first.\n\n• Ten notes\n• One a day");
    expect(text).not.toMatch(/rubbish-step1|4205|github|\bu\d/);
    expect(cardShareText(update({ ask: undefined }))).toBe("Rubbish notes: step 1");
  });

  it("hands a card without media to the share sheet as text, inside the tap", () => {
    const button = cardShareButton(update(), "upd-share");
    expect(button.textContent).toBe("Share");
    button.click();
    expect(shares).toEqual([{ text: cardShareText(update()) }]);
  });

  it("sends the After clip with the text, named for the card", async () => {
    cardShareButton(update({ media: { kind: "before-after", before: clip("a"), after: clip("b") } }), "upd-share").click();
    await settle();
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual([`/media/${"b".repeat(64)}`]);
    expect(shares).toHaveLength(1);
    expect(shares[0]!.text).toBe(cardShareText(update()));
    expect(shares[0]!.files!.map((file) => [file.name, file.type])).toEqual([["rubbish-notes-step-1-after.mp4", "video/mp4"]]);
  });

  it("sends nothing when the thing turned app-only while its files were coming", async () => {
    let open = true;
    cardShareButton(update({ media: { kind: "before-after", before: clip("a"), after: clip("b") } }), "upd-share", () => open).click();
    open = false;
    await settle();
    expect(shares).toEqual([]);
  });

  it("keeps nothing and opens no share sheet when the download finishes after sign-out", async () => {
    const media = { kind: "video" as const, after: clip("b") };
    cardShareButton(update({ media }), "upd-share").click();
    endSession();
    await settle();
    expect(shares).toEqual([]);
    // Nothing was kept: the next session's tap downloads again.
    cardShareButton(update({ media }), "upd-share").click();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(shares).toHaveLength(1);
  });

  it.each(["copied", "not copied"])("sends nothing when sign-out comes while the text is being copied (%s)", async (outcome) => {
    let finish!: () => void;
    writeText = vi.fn(() => new Promise<void>((resolve, reject) => (finish = outcome === "copied" ? resolve : () => reject(new Error("denied")))));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    cardShareButton(update({ media: { kind: "stills", stills: [still("c"), still("c")] } }), "upd-share").click();
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    endSession();
    finish();
    await settle();
    expect(shares).toEqual([]);
    expect(flashed).toEqual([]);
  });

  it("forgets the files it kept when the session ends", async () => {
    sharePlan = ["NotAllowedError"];
    const media = { kind: "video" as const, after: clip("b") };
    cardShareButton(update({ media }), "upd-share").click();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    endSession();
    const button = cardShareButton(update({ media }), "upd-share");
    button.click();
    // No kept files to send inside the tap: it downloads them again.
    expect(shares).toHaveLength(1);
    expect(button.textContent).toBe("Getting…");
    expect(fetch).toHaveBeenCalledTimes(2);
    await settle();
  });

  it("sends every screenshot of a stills card", async () => {
    cardShareButton(update({ media: { kind: "stills", stills: [still("c"), still("c")] } }), "upd-share").click();
    await settle();
    expect(shares[0]!.files!.map((file) => file.name)).toEqual(["rubbish-notes-step-1-1.png", "rubbish-notes-step-1-2.png"]);
  });

  // message on Android put a multi-file share's text under every picture.
  describe("with two or more files, the text goes once", () => {
    const stills = { kind: "stills" as const, stills: [still("c"), still("c"), still("c")] };

    it("copies the text, says so, and sends the files without it", async () => {
      cardShareButton(update({ media: stills }), "upd-share").click();
      await settle();
      expect(writeText).toHaveBeenCalledWith(cardShareText(update()));
      expect(writeText.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(navigator.share).mock.invocationCallOrder[0]!);
      expect(shares).toHaveLength(1);
      expect(shares[0]).not.toHaveProperty("text");
      expect(shares[0]!.files).toHaveLength(3);
      expect(flashed).toEqual(["Text copied. Paste it once as the caption."]);
    });

    it("does the same on the second tap that sends the files the download kept", async () => {
      sharePlan = ["NotAllowedError"];
      const button = cardShareButton(update({ media: stills }), "upd-share");
      button.click();
      await settle();
      button.click();
      await settle();
      expect(shares.map((data) => [data.files?.length, "text" in data])).toEqual([
        [3, false],
        [3, false],
      ]);
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("counts a clip and a file the same as pictures", async () => {
      vi.mocked(fetch).mockImplementation((input) =>
        Promise.resolve(String(input).startsWith(`/media/${"d"}`) ? new Response(new TextEncoder().encode("%PDF-1.7\n"), { headers: { "content-type": "application/pdf" } }) : new Response(BYTES, { headers: { "content-type": "video/mp4" } })),
      );
      const files = [{ sha256: "d".repeat(64), type: "application/pdf" as const, name: "Report.pdf", bytes: 7_000 }];
      cardShareButton(update({ media: { kind: "video", after: clip("b"), files } }), "upd-share").click();
      await settle();
      expect(shares[0]!.files!.map((file) => file.name)).toEqual(["rubbish-notes-step-1-after.mp4", "Report.pdf"]);
      expect(shares[0]).not.toHaveProperty("text");
    });

    it("sends the text with the files when it cannot be copied", async () => {
      writeText.mockImplementation(() => Promise.reject(new DOMException("blocked", "NotAllowedError")));
      cardShareButton(update({ media: stills }), "upd-share").click();
      await settle();
      expect(shares).toHaveLength(1);
      expect(shares[0]!.text).toBe(cardShareText(update()));
      expect(shares[0]!.files).toHaveLength(3);
      expect(flashed).toEqual([]);
    });

    it("leaves one file and its text together, copying nothing", async () => {
      cardShareButton(update({ media: { kind: "stills", stills: [still("c")] } }), "upd-share").click();
      await settle();
      expect(shares[0]!.text).toBe(cardShareText(update()));
      expect(shares[0]!.files).toHaveLength(1);
      expect(writeText).not.toHaveBeenCalled();
    });
  });

  it("sends the card's files with its text: a Markdown file as plain text, and none a share sheet refuses (2026-10-07)", async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response("# Workbench prompt\n", { headers: { "content-type": "text/plain; charset=utf-8" } })));
    const files = [
      { sha256: "d".repeat(64), type: "text/markdown" as const, name: "Workbench prompt (locked-down laptop).md", bytes: 7_000 },
      { sha256: "e".repeat(64), type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const, name: "Budget.xlsx", bytes: 18_000 },
    ];
    cardShareButton(update({ media: { kind: "files", files } }), "upd-share").click();
    await settle();
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual([`/media/${"d".repeat(64)}`]);
    expect(shares).toHaveLength(1);
    expect(shares[0]!.text).toBe(cardShareText(update()));
    expect(shares[0]!.files!.map((file) => [file.name, file.type])).toEqual([["Workbench prompt (locked-down laptop).txt", "text/plain"]]);
  });

  it("when the download used the tap up, keeps the files and a second tap sends them without fetching again", async () => {
    sharePlan = ["NotAllowedError"];
    const button = cardShareButton(update({ media: { kind: "video", after: clip("b") } }), "upd-share");
    button.click();
    expect(button.textContent).toBe("Getting…");
    await settle();
    expect(flashed).toEqual(["Got the files. Tap Share again to send them."]);
    expect(button.textContent).toBe("Share");
    button.click();
    expect(shares).toHaveLength(2);
    expect(shares[1]!.files).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps what came for the card, so the button a redraw put in place sends it on the next tap", async () => {
    sharePlan = ["NotAllowedError"];
    const media = { kind: "video" as const, after: clip("b") };
    const first = cardShareButton(update({ media }), "upd-share");
    document.body.append(first);
    first.click();
    // The feed redraws while the clip comes: the new button shows the download under way and ignores a tap meanwhile.
    first.remove();
    const redrawn = cardShareButton(update({ media }), "upd-share");
    document.body.append(redrawn);
    expect(redrawn.textContent).toBe("Getting…");
    redrawn.click();
    await settle();
    expect(redrawn.textContent).toBe("Share");
    expect(redrawn.hasAttribute("aria-busy")).toBe(false);
    redrawn.click();
    expect(shares.map((data) => data.files?.length)).toEqual([1, 1]);
    expect(fetch).toHaveBeenCalledTimes(1);
    redrawn.remove();
  });

  it("keeps the screenshots that came when one fails, and sends them on the next tap without fetching again", async () => {
    sharePlan = ["NotAllowedError"];
    vi.mocked(fetch).mockImplementationOnce(() => Promise.resolve(new Response("gone", { status: 404 })));
    const button = cardShareButton(update({ media: { kind: "stills", stills: [still("c"), still("c")] } }), "upd-share");
    button.click();
    await settle();
    button.click();
    expect(shares.map((data) => data.files?.map((file) => file.name))).toEqual([["rubbish-notes-step-1-2.png"], ["rubbish-notes-step-1-2.png"]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends no more than Chrome takes in one share: ten files and 50 MiB, in the card's order", async () => {
    const pdf = (c: string) => ({ sha256: c.repeat(64), type: "application/pdf" as const, name: `${c}.pdf`, bytes: 20 * 1024 * 1024 });
    const big = new Uint8Array(20 * 1024 * 1024);
    big.set(new TextEncoder().encode("%PDF-"));
    vi.mocked(fetch).mockImplementation((input) =>
      Promise.resolve(String(input).startsWith(`/media/${"c"}`) ? new Response(BYTES, { headers: { "content-type": "image/png" } }) : new Response(big, { headers: { "content-type": "application/pdf" } })),
    );
    const stills = Array.from({ length: 8 }, () => still("c"));
    cardShareButton(update({ media: { kind: "stills", stills, files: [pdf("d"), pdf("e"), pdf("f")] } }), "upd-share").click();
    await settle();
    const sent = shares[0]!.files!;
    expect(sent.map((file) => file.name)).toEqual([...stills.map((_, index) => `rubbish-notes-step-1-${index + 1}.png`), "d.pdf", "e.pdf"]);
    expect(sent.reduce((bytes, file) => bytes + file.size, 0)).toBeLessThanOrEqual(50 * 1024 * 1024);
  });

  it("sends the text alone, now and on every later tap, when the clip that came is over what Chrome takes", async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response(new Uint8Array(51 * 1024 * 1024), { headers: { "content-type": "video/mp4" } })));
    const button = cardShareButton(update({ media: { kind: "video", after: clip("b") } }), "upd-share");
    button.click();
    await settle();
    button.click();
    button.click();
    expect(shares).toEqual([{ text: cardShareText(update()) }, { text: cardShareText(update()) }, { text: cardShareText(update()) }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("when no file came, sends the text; the next tap sends it at once, and the one after tries the download again", async () => {
    sharePlan = ["NotAllowedError"];
    vi.mocked(fetch).mockImplementationOnce(() => Promise.resolve(new Response("unavailable", { status: 503 })));
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response(new TextEncoder().encode("%PDF-1.7\n"), { headers: { "content-type": "application/pdf" } })));
    const files = [{ sha256: "d".repeat(64), type: "application/pdf" as const, name: "Report.pdf", bytes: 7_000 }];
    const button = cardShareButton(update({ media: { kind: "files", files } }), "upd-share");
    button.click();
    await settle();
    expect(flashed).toEqual(["Couldn't open the share sheet. Try again."]);
    button.click();
    expect(shares).toEqual([{ text: cardShareText(update()) }, { text: cardShareText(update()) }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    button.click();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(shares[2]!.files!.map((file) => file.name)).toEqual(["Report.pdf"]);
  });

  it("sends the text alone when the phone cannot take the files, and says nothing when you closes the sheet", async () => {
    canShare = false;
    sharePlan = ["AbortError"];
    cardShareButton(update({ media: { kind: "video", after: clip("b") } }), "upd-share").click();
    await settle();
    expect(shares).toEqual([{ text: cardShareText(update()) }]);
    expect(flashed).toEqual([]);
  });

  it("without a share sheet, copies the text and says Copied", async () => {
    Reflect.deleteProperty(navigator, "share");
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    cardShareButton(update(), "upd-share").click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(cardShareText(update()));
    expect(flashed).toEqual(["Copied"]);
  });

  it("keeps the tap from opening the card's thread", () => {
    const card = document.createElement("article");
    const opened = vi.fn();
    card.addEventListener("click", opened);
    card.append(cardShareButton(update(), "upd-share"));
    card.querySelector("button")!.click();
    expect(opened).not.toHaveBeenCalled();
  });
});
