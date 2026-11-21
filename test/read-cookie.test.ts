import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { readCookie } from "../src/server/httputil.js";

const withCookie = (cookie: string) => ({ headers: { cookie } }) as IncomingMessage;

describe("readCookie", () => {
  it("reads the exact name past HTTP whitespace", () => {
    expect(readCookie(withCookie("a=1;\t __Host-rivet=tok ; b=2"), "__Host-rivet")).toBe("tok");
  });

  it("refuses a U+00A0-led lookalike name", () => {
    expect(readCookie(withCookie("\xa0__Host-rivet=planted"), "__Host-rivet")).toBeNull();
    expect(readCookie(withCookie("\xa0__Host-rivet=planted; __Host-rivet=real"), "__Host-rivet")).toBe("real");
  });
});
