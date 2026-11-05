import { vi } from "vitest";

const noop = () => undefined;

/** happy-dom has no 2D canvas; the scene only needs calls that do nothing. */
function fakeContext(): CanvasRenderingContext2D {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "createImageData" || prop === "getImageData") {
        const image = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
        return prop === "getImageData" ? (_x: number, _y: number, w: number, h: number) => image(w, h) : image;
      }
      if (prop === "measureText") return () => ({ width: 0 });
      if (typeof prop === "string" && /^create.*(Gradient|Pattern)$/.test(prop)) return () => ({ addColorStop: noop, setTransform: noop });
      return noop;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

export function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeContext() as never);
}
