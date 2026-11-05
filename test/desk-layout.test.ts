import { describe, expect, it } from "vitest";

import { clampWidth, DEFAULT_LAYOUT, paneOpen, parseLayout, toggleFocus, togglePane } from "../web/src/desk-layout.js";

describe("the desktop layout's stored state", () => {
  it("fills anything missing or malformed with its default", () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("{not json")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify({ rail: "sideways", list: "no", listW: "wide", chatW: 5000 }))).toEqual({ ...DEFAULT_LAYOUT, chatW: 640 });
    expect(parseLayout(JSON.stringify({ rail: "icons", focus: true, chatW: 100 }))).toEqual({ ...DEFAULT_LAYOUT, rail: "icons", focus: true, chatW: 300 });
  });

  it("keeps chat closed for someone who closed it before the layout was stored whole", () => {
    expect(parseLayout(null, "closed").chat).toBe(false);
    expect(parseLayout(null, "open").chat).toBe(true);
    expect(parseLayout(JSON.stringify({ chat: true }), "closed").chat).toBe(true);
  });

  it("clamps dragged widths", () => {
    expect(clampWidth("chat", 10)).toBe(300);
    expect(clampWidth("chat", 400.4)).toBe(400);
    expect(clampWidth("chat", 9999)).toBe(640);
  });
});

describe("opening and collapsing panes", () => {
  it("the rail follows the window until you picks labels or icons", () => {
    expect(paneOpen(DEFAULT_LAYOUT, "rail", true)).toBe(true);
    expect(paneOpen(DEFAULT_LAYOUT, "rail", false)).toBe(false);
    expect(togglePane(DEFAULT_LAYOUT, "rail", true).rail).toBe("icons");
    expect(togglePane(DEFAULT_LAYOUT, "rail", false).rail).toBe("full");
  });

  it("Focus collapses every pane and turning it off brings them back", () => {
    const focused = toggleFocus(DEFAULT_LAYOUT);
    for (const pane of ["rail", "chat"] as const) expect(paneOpen(focused, pane, true)).toBe(false);
    expect(toggleFocus(focused)).toEqual(DEFAULT_LAYOUT);
  });

  it("opening one pane from Focus leaves Focus with only that pane open", () => {
    const next = togglePane(toggleFocus(DEFAULT_LAYOUT), "chat", true);
    expect(next.focus).toBe(false);
    expect(paneOpen(next, "chat", true)).toBe(true);
    expect(paneOpen(next, "rail", true)).toBe(false);
  });
});
