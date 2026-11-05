// Dev-only Media tab fixtures for web/preview/desktop.html?tab=media[&tap=<n>]: several days of card and chat
// photos and clips, drawn here on a canvas so the preview needs no files. `tap` opens the n-th thumbnail (0 first) in
// the viewer once the list is in. Nothing imports this from the app, so the production build leaves it out.
import type { MediaItem, MediaItemType, MediaPage } from "../../../src/shared/media.js";

declare global {
  interface Window {
    /** Layout-test-only base64 WebM fixtures, keyed by their actual dimensions. */
    __RIVET_PREVIEW_CLIPS__?: Record<string, string>;
  }
}

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const DAY = 1440;
const sha = (n: number) => `${n.toString(16).padStart(2, "0")}${"7".repeat(62)}`;

type Shape = { type: MediaItemType; poster?: true };
let next = 0;
const drawn = new Map<string, { type: MediaItemType; hue: number; label: string; width?: number; height?: number; scene?: true }>();
function media(shapes: Shape[], base: Omit<MediaItem, "sha" | "type" | "poster">): MediaItem[] {
  return shapes.map((shape, i) => {
    const id = sha(++next);
    drawn.set(id, { type: shape.type, hue: (next * 47) % 360, label: `${base.title.split(":")[0]} ${i + 1}` });
    const item: MediaItem = { ...base, sha: id, type: shape.type };
    if (shape.poster) {
      const poster = sha(++next);
      drawn.set(poster, { type: "image/png", hue: (next * 47) % 360, label: `${base.title.split(":")[0]} clip` });
      item.poster = poster;
    }
    return item;
  });
}
const png: Shape = { type: "image/png" };

const first: MediaItem[] = [
  ...media([{ type: "video/webm", poster: true }, png, png], {
    at: ago(5),
    source: "card",
    title: "Onboarding: the welcome animation",
    card: { id: "welcome-animation", onBoard: true },
  }),
  ...media([png, png], { at: ago(58), source: "chat", title: "Checkout results row", chat: { conversation: "k1", message: "k3" } }),
  ...media([png, png, png], {
    at: ago(DAY + 30),
    source: "card",
    title: "Checkout: the new layout",
    card: {
      id: "checkout-layout",
      onBoard: false,
      ask: "The totals move to the gold frame from the summary screen. Do they read at a glance on your phone?",
      answer: { decision: "choice", choice: "Ship it", text: "lovely, the gold reads at a glance", at: ago(DAY - 20) },
    },
  }),
  ...media([png], { at: ago(2 * DAY + 200), source: "card", title: "Settings: the account screen", card: { id: "account-screen", onBoard: false } }),
  ...media([{ type: "video/webm" }], { at: ago(3 * DAY + 90), source: "chat", title: "Updates", chat: { conversation: "updates", message: "u1" } }),
  ...media([png, png, png, png, png, png], {
    at: ago(4 * DAY + 400),
    source: "card",
    title: "Dashboard: a calmer chart animation across the whole screen",
    card: { id: "dashboard-chart", onBoard: false, answer: { decision: "approve", at: ago(4 * DAY + 300) } },
  }),
];
const second: MediaItem[] = [
  ...media([png], { at: ago(6 * DAY), source: "chat", title: "quote enquiry form", chat: { conversation: "g1", message: "g2" } }),
  ...media([png, png], { at: ago(7 * DAY + 60), source: "card", title: "Notifications: v2 sound pass", card: { id: "notify-sound", onBoard: false } }),
];

/** GET /api/media in the preview: two pages, so More shows. */
/** Draws `id` as a still for a fixture outside the Media tab, such as an update card's. */
export function drawnStill(id: string, label: string, hue: number, width?: number, height?: number): string {
  drawn.set(id, { type: "image/png", hue, label, width, height });
  return id;
}

/** Draws `id` as a still of a sample screen, `label` its look, for a card that must read as a picture. */
export function gameStill(id: string, label: string, hue: number): string {
  drawn.set(id, { type: "image/png", hue, label, width: 720, height: 540, scene: true });
  return id;
}

/** Draws `id` as a two-second clip for a fixture outside the Media tab, such as a card's video. */
export function drawnClip(id: string, label: string, hue: number, width?: number, height?: number): string {
  drawn.set(id, { type: "video/webm", hue, label, width, height });
  return id;
}

export function previewMediaPage(url: string): MediaPage {
  return new URL(url, location.origin).searchParams.get("before") ? { items: second, next: null } : { items: first, next: "page-2" };
}

function picture(hue: number, label: string, frame = 0, width = 540, height = 720): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  paint(canvas, hue, label, frame);
  return canvas;
}

/** A sample screen of round shapes under a sky, one popping in the given look. */
function gameScreen(hue: number, label: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 540;
  const g = canvas.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, 540);
  sky.addColorStop(0, "#2b1d5c");
  sky.addColorStop(1, "#7a2f6b");
  g.fillStyle = sky;
  g.fillRect(0, 0, 720, 540);
  g.fillStyle = "#5a3a1e";
  g.fillRect(70, 70, 580, 370);
  g.fillStyle = "#8a5a2b";
  g.fillRect(86, 86, 548, 338);
  const colours = ["#ff4d5e", "#ffc23d", "#4dd6a0", "#5aa8ff", "#c77dff"];
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 5; col++) {
      const x = 140 + col * 110;
      const y = 140 + row * 80;
      const won = row === 1 && col === 2;
      if (won) {
        g.fillStyle = `hsl(${hue} 95% 60% / 0.55)`;
        g.beginPath();
        g.arc(x, y, 52, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = colours[(row * 5 + col) % colours.length]!;
      g.beginPath();
      g.ellipse(x, y, won ? 36 : 28, won ? 42 : 33, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(255,255,255,0.55)";
      g.beginPath();
      g.ellipse(x - 9, y - 12, 7, 10, -0.5, 0, Math.PI * 2);
      g.fill();
    }
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillRect(0, 0, 720, 56);
  g.fillRect(0, 470, 720, 70);
  g.fillStyle = "#ffc23d";
  g.font = "bold 36px system-ui";
  g.textAlign = "center";
  g.fillText(label, 360, 40);
  g.fillStyle = "#4dd6a0";
  g.fillRect(250, 482, 220, 46);
  g.fillStyle = "#10231a";
  g.font = "bold 28px system-ui";
  g.fillText("OPEN", 360, 515);
  return canvas;
}

function paint(canvas: HTMLCanvasElement, hue: number, label: string, frame: number): void {
  const g = canvas.getContext("2d")!;
  const fill = g.createLinearGradient(0, 0, canvas.width, canvas.height);
  fill.addColorStop(0, `hsl(${hue} 70% 45%)`);
  fill.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 20%)`);
  g.fillStyle = fill;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.beginPath();
  g.arc(canvas.width / 2 + Math.sin(frame / 8) * 160, 300, 70, 0, Math.PI * 2);
  g.fill();
  g.font = "bold 44px system-ui";
  g.textAlign = "center";
  g.fillText(label, canvas.width / 2, 560);
}

const blobs = new Map<string, Promise<Blob | null>>();
function blobOf(id: string): Promise<Blob | null> {
  const known = drawn.get(id);
  if (!known) return Promise.resolve(null);
  let blob = blobs.get(id);
  if (!blob) {
    blob = known.type.startsWith("video/") ? keptClip(known.hue, known.label, known.width, known.height) : new Promise((resolve) => (known.scene ? gameScreen(known.hue, known.label) : picture(known.hue, known.label, 0, known.width, known.height)).toBlob(resolve, "image/png"));
    blobs.set(id, blob);
  }
  return blob;
}

/**
 * The clip, recorded once and kept in the browser's Cache across reloads: recording paints the canvas on the main thread
 * for two seconds, and a phone's Feed holds every card's clip, so a page that reloads card by card (the Feed checks)
 * spent most of each load recording. Keyed by the drawing code, so an edit to it draws afresh.
 */
async function keptClip(hue: number, label: string, width?: number, height?: number): Promise<Blob | null> {
  if (window.__RIVET_PREVIEW_CLIPS__) {
    const size = `${width ?? 540}x${height ?? 720}`;
    const fixture = window.__RIVET_PREVIEW_CLIPS__[size];
    if (!fixture) throw new Error(`Missing preview clip fixture: ${size}`);
    return new Blob([Uint8Array.from(atob(fixture), (char) => char.charCodeAt(0))], { type: "video/webm" });
  }
  const store = typeof caches === "undefined" ? null : await caches.open("rivet-preview-clips").catch(() => null);
  let code = 0;
  for (const char of `${picture}${paint}${clip}`) code = (code * 31 + char.charCodeAt(0)) | 0;
  const key = `/preview-clips/${code}/${hue}/${width ?? ""}x${height ?? ""}/${encodeURIComponent(label)}`;
  const kept = await store?.match(key).then((found) => found?.blob()).catch(() => undefined);
  if (kept?.size) return kept;
  const blob = await clip(hue, label, width, height);
  if (blob?.size && store) await store.put(key, new Response(blob, { headers: { "content-type": blob.type || "video/webm" } })).catch(() => undefined);
  return blob;
}

/** A two-second clip of the canvas, where the browser can record one. */
function clip(hue: number, label: string, width?: number, height?: number): Promise<Blob | null> {
  const canvas = picture(hue, label, 0, width, height);
  if (typeof MediaRecorder === "undefined" || !canvas.captureStream) return Promise.resolve(null);
  return new Promise((resolve) => {
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
    const parts: Blob[] = [];
    recorder.ondataavailable = (event) => parts.push(event.data);
    recorder.onstop = () => resolve(new Blob(parts, { type: "video/webm" }));
    let frame = 0;
    const timer = setInterval(() => paint(canvas, hue, label, ++frame), 33);
    recorder.start();
    setTimeout(() => {
      clearInterval(timer);
      recorder.stop();
    }, 2000);
  });
}

/** The fixture's /media/ file, for the preview's fetch (Share); null for any other path. */
export async function previewMediaFile(url: string): Promise<Response | null> {
  const id = url.split("/media/")[1]?.split(/[?#]/)[0] ?? "";
  const known = drawn.get(id);
  const blob = known ? await blobOf(id) : null;
  return blob ? new Response(blob, { headers: { "content-type": known!.type } }) : null;
}

/**
 * Points every fixture /media/ src and poster at its drawn file. `window.previewMediaDrawn` resolves once every swap
 * begun so far is done, so a layout check waits for the drawn stills rather than the fixture src that fails before them.
 */
export function drawPreviewMedia(): void {
  const pending = new Set<Promise<void>>();
  (window as { previewMediaDrawn?: () => Promise<unknown> }).previewMediaDrawn = () => Promise.all(pending);
  const swap = (el: Element, attr: "src" | "poster") => {
    const done = swapNow(el, attr).finally(() => pending.delete(done));
    pending.add(done);
  };
  const swapNow = async (el: Element, attr: "src" | "poster") => {
    const value = el.getAttribute(attr) ?? "";
    const [path, hash] = value.split("#");
    const id = value.startsWith("/media/") ? path!.slice("/media/".length) : "";
    if (!drawn.has(id)) return;
    const blob = await blobOf(id);
    if (blob && el.getAttribute(attr) === value) el.setAttribute(attr, `${URL.createObjectURL(blob)}${hash ? `#${hash}` : ""}`);
  };
  const scan = (root: ParentNode) => {
    for (const el of root.querySelectorAll('[src^="/media/"]')) swap(el, "src");
    for (const el of root.querySelectorAll('[poster^="/media/"]')) swap(el, "poster");
  };
  new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === "attributes") swap(change.target as Element, change.attributeName as "src" | "poster");
      else for (const node of change.addedNodes) if (node instanceof Element) scan(node.parentNode ?? node);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "poster"] });
  scan(document);
}

/** Opens the n-th thumbnail once the list has drawn. */
export function tapPreviewThumb(n: number): void {
  const tryTap = (left: number) => {
    const thumb = document.querySelectorAll<HTMLButtonElement>(".media-tab-thumb")[n];
    if (thumb) thumb.click();
    else if (left > 0) setTimeout(() => tryTap(left - 1), 100);
  };
  tryTap(50);
}
