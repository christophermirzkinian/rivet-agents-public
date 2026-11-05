/// <reference types="vite/client" />
// Loaded only when a PDF is opened, so pdf.js stays out of the app's own bundle. The legacy build runs on Safari
// versions the modern one has left behind.
import { getDocument, GlobalWorkerOptions, type PDFPageProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

import { h } from "../dom.js";
import { within } from "../within.js";
import type { LightboxContent } from "./lightbox.js";
import type { Size, View } from "./zoom.js";

GlobalWorkerOptions.workerSrc = workerSrc;

const MAX_WIDTH = 960;
const GAP = 10;
const MAX_SCALE = 6;
// iPhone Safari refuses a canvas over 16.7M pixels and starts dropping canvases past a few hundred MB in all, so a
// page's whole-page canvas stays small and zooming in draws only the part on screen, at the screen's own resolution.
const MAX_PAGE_PIXELS = 6_000_000;
/** One embedded image's decode, in pixels; a bigger one is left out of the page rather than taking the memory. */
const MAX_IMAGE_PIXELS = 16_000_000;
/** While the view moves, pages coming on screen get drawn this often; the sharp pass waits for it to stop. */
const MOVING_RENDER_MS = 120;
/** The decoders, CMaps, ICC profiles and fonts pdf.js fetches for some PDFs, copied into the build by vite.config.ts. */
const ASSETS = "/pdfjs/";
/** pdf.js's worker start, document load or page load: a stalled one fails like a broken PDF. */
export const PDF_STEP_MS = 30_000;
const step = <T>(promise: Promise<T>): Promise<T> => within(promise, PDF_STEP_MS, "PDF step took too long");

interface Page {
  proxy: PDFPageProxy;
  /** Height over width. */
  ratio: number;
  el: HTMLElement;
  /** Whole page at fit width, and its width in canvas pixels (0 when not drawn). */
  base: HTMLCanvasElement | null;
  baseWidth: number;
  /** The whole-page render under way, and its width. */
  baseRender: RenderTask | null;
  baseTarget: number;
  /** The part on screen at the current zoom. */
  detail: HTMLCanvasElement | null;
  detailRender: RenderTask | null;
  /** pdf.js holds this page's decoded images until cleanup. */
  used: boolean;
  /** Top at scale 1, in fit pixels. */
  top: number;
  height: number;
}

export async function pdfContent(data: Uint8Array, signal: AbortSignal): Promise<LightboxContent> {
  const assets = (dir: string) => new URL(`${ASSETS}${dir}/`, location.href).href;
  const task = getDocument({
    data,
    maxImageSize: MAX_IMAGE_PIXELS,
    wasmUrl: assets("wasm"),
    cMapUrl: assets("cmaps"),
    cMapPacked: true,
    iccUrl: assets("iccs"),
    standardFontDataUrl: assets("standard_fonts"),
  });
  signal.addEventListener("abort", () => void task.destroy());
  const doc = await step(task.promise);
  const pages: Page[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const proxy = await step(doc.getPage(i));
    const { width, height } = proxy.getViewport({ scale: 1 });
    const el = h("div", { class: "lightbox-page", attrs: { "aria-label": `Page ${i} of ${doc.numPages}`, role: "img" } });
    pages.push({ proxy, ratio: height / width, el, base: null, baseWidth: 0, baseRender: null, baseTarget: 0, detail: null, detailRender: null, used: false, top: 0, height: 0 });
  }
  const el = h("div", { class: "lightbox-pages" }, ...pages.map((page) => page.el));
  let generation = 0;
  let width = 0;
  let lastMovingPass = 0;

  const render = (page: Page, canvas: HTMLCanvasElement, pixelWidth: number, offset: [number, number] = [0, 0]): RenderTask => {
    const unit = page.proxy.getViewport({ scale: 1 });
    const viewport = page.proxy.getViewport({ scale: pixelWidth / unit.width });
    page.used = true;
    return page.proxy.render({ canvas, viewport, transform: [1, 0, 0, 1, -offset[0], -offset[1]], background: "#ffffff" });
  };
  const finished = async (task: RenderTask) => {
    try {
      // No deadline here: a page that renders slowly on a phone still renders, and a page left blank is not stuck.
      await task.promise;
      return true;
    } catch {
      return false;
    }
  };
  const release = (canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  };
  const dropDetail = (page: Page) => {
    page.detailRender?.cancel();
    page.detailRender = null;
    release(page.detail);
    page.detail = null;
  };
  const evict = async (page: Page) => {
    const running = [page.baseRender, page.detailRender];
    page.baseRender?.cancel();
    page.baseRender = null;
    release(page.base);
    page.base = null;
    page.baseWidth = 0;
    dropDetail(page);
    if (!page.used) return;
    page.used = false;
    // pdf.js keeps the page's decoded images until it is cleaned up, which waits for its renders to wind down.
    await Promise.all(running.map((task) => task && finished(task)));
    page.proxy.cleanup();
  };

  const dpr = () => Math.min(window.devicePixelRatio || 1, 3);
  const screenTop = (view: View, page: Page) => view.y + page.top * view.scale;
  const within = (view: View, page: Page, from: number, to: number) => screenTop(view, page) + page.height * view.scale > from && screenTop(view, page) < to;
  const baseFor = (page: Page) => Math.min(Math.round(width * dpr()), Math.floor(Math.sqrt(MAX_PAGE_PIXELS / page.ratio)));
  const ensureBase = async (page: Page) => {
    const target = baseFor(page);
    if (page.base && Math.abs(page.baseWidth - target) / target < 0.1) return;
    if (page.baseRender && page.baseTarget === target) {
      await finished(page.baseRender);
      return;
    }
    page.baseRender?.cancel();
    const canvas = h("canvas", { class: "lightbox-base" });
    canvas.width = target;
    canvas.height = Math.round(target * page.ratio);
    const task = render(page, canvas, target);
    page.baseRender = task;
    page.baseTarget = target;
    const drawn = await finished(task);
    if (page.baseRender === task) page.baseRender = null;
    if (!drawn) return release(canvas);
    release(page.base);
    page.base = canvas;
    page.baseWidth = target;
    page.el.prepend(canvas);
  };

  /** Pages far off screen let go of their canvases; the pages on screen get theirs, whole, so none shows blank. */
  const drawWhole = async (view: View, stage: Size) => {
    for (const page of pages) {
      if (!within(view, page, -stage.h * 4, stage.h * 5) && (page.base || page.baseRender || page.used)) void evict(page);
    }
    const visible = pages.filter((page) => within(view, page, 0, stage.h));
    for (const page of pages) if (page.detail && !visible.includes(page)) dropDetail(page);
    for (const page of visible) await ensureBase(page);
    return visible;
  };

  /** Once the view stops: whole pages on screen, then the sharp part on screen, then the pages either side. */
  const renderSettled = async (view: View, stage: Size) => {
    const mine = ++generation;
    for (const page of pages) {
      page.detailRender?.cancel();
      page.detailRender = null;
    }
    const visible = await drawWhole(view, stage);
    if (mine !== generation) return;
    const scale = dpr();
    for (const page of visible) {
      const pageWidth = width * view.scale;
      if (pageWidth * scale <= page.baseWidth * 1.05) {
        dropDetail(page);
        continue;
      }
      const left = Math.max(0, -view.x);
      const top = Math.max(0, -screenTop(view, page));
      const right = Math.min(pageWidth, stage.w - view.x);
      const bottom = Math.min(page.height * view.scale, stage.h - screenTop(view, page));
      if (right <= left || bottom <= top) continue;
      const canvas = h("canvas", { class: "lightbox-detail" });
      canvas.width = Math.ceil((right - left) * scale);
      canvas.height = Math.ceil((bottom - top) * scale);
      const pageHeight = page.height * view.scale;
      Object.assign(canvas.style, {
        left: `${(left / pageWidth) * 100}%`,
        top: `${(top / pageHeight) * 100}%`,
        width: `${((right - left) / pageWidth) * 100}%`,
        height: `${((bottom - top) / pageHeight) * 100}%`,
      });
      const task = render(page, canvas, pageWidth * scale, [left * scale, top * scale]);
      page.detailRender = task;
      const drawn = await finished(task);
      if (page.detailRender === task) page.detailRender = null;
      if (!drawn || mine !== generation) {
        release(canvas);
        return;
      }
      release(page.detail);
      page.detail = canvas;
      page.el.append(canvas);
    }
    for (const page of pages.filter((page) => within(view, page, -stage.h * 1.5, stage.h * 2.5))) {
      await ensureBase(page);
      if (mine !== generation) return;
    }
  };

  const pageAt = (view: View, stage: Size) => {
    const middle = (stage.h / 2 - view.y) / view.scale;
    const index = pages.findIndex((page) => page.top + page.height + GAP / 2 > middle);
    return (index < 0 ? pages.length - 1 : index) + 1;
  };

  return {
    el,
    fit(stage) {
      width = Math.min(stage.w, MAX_WIDTH);
      let top = GAP;
      for (const page of pages) {
        page.top = top;
        page.height = width * page.ratio;
        top += page.height + GAP;
      }
      // Laid out in shares of the whole, so the pages grow with the box as it zooms.
      for (const page of pages) {
        page.el.style.top = `${(page.top / top) * 100}%`;
        page.el.style.height = `${(page.height / top) * 100}%`;
      }
      return { w: width, h: top };
    },
    maxScale: () => MAX_SCALE,
    moved(view, _fit, stage, settled) {
      if (settled) void renderSettled(view, stage);
      else if (performance.now() - lastMovingPass >= MOVING_RENDER_MS) {
        lastMovingPass = performance.now();
        void drawWhole(view, stage);
      }
      return pages.length > 1 ? `Page ${pageAt(view, stage)} of ${pages.length}` : "";
    },
    destroy() {
      generation++;
      for (const page of pages) {
        page.baseRender?.cancel();
        release(page.base);
        dropDetail(page);
      }
      el.remove();
      void task.destroy();
    },
  };
}
