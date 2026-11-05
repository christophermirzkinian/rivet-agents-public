// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { h, linkify } from "../web/src/dom.js";

// The linear-time guards below time CPU, not the wall clock: a loaded runner stalls a run until its CPU quota
// refills, while a quadratic or backtracking parse still costs the CPU it always did.
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

const render = (text: string) => h("p", {}, ...linkify(text));
const links = (text: string) => [...render(text).querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), text: a.textContent }));

describe("links in plain text", () => {
  it("links https URLs, opening outside the app, and keeps every other character as text", () => {
    const p = render("Live at https://rivet.example.com/?tab=feed now.\nAlso https://github.com/x/y/pull/2504");
    expect(p.textContent).toBe("Live at https://rivet.example.com/?tab=feed now.\nAlso https://github.com/x/y/pull/2504");
    const anchors = [...p.querySelectorAll("a")];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["https://rivet.example.com/?tab=feed", "https://github.com/x/y/pull/2504"]);
    for (const a of anchors) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.className).toBe("text-link");
    }
  });

  it("drops the sentence's punctuation and an unopened bracket, but keeps brackets the URL opened", () => {
    expect(links("See https://example.com/a.")).toEqual([{ href: "https://example.com/a", text: "https://example.com/a" }]);
    expect(links("(see https://example.com/a), then?")[0]!.text).toBe("https://example.com/a");
    expect(links("Is it https://example.com/a?!")[0]!.text).toBe("https://example.com/a");
    expect(links("“https://example.com/q”")[0]!.text).toBe("https://example.com/q");
    expect(links("https://en.wikipedia.org/wiki/Mercury_(planet).")[0]!.text).toBe("https://en.wikipedia.org/wiki/Mercury_(planet)");
    expect(links("[https://example.com/x]")[0]!.text).toBe("https://example.com/x");
    expect(links("https://example.com/download?token=abc_")[0]!.text, "a trailing _ is part of a token").toBe("https://example.com/download?token=abc_");
    expect(links("https://example.com/~owner~")[0]!.text).toBe("https://example.com/~owner~");
  });

  it("trims a long run of closing brackets in linear time", () => {
    const hostile = `https://example.com/${")".repeat(3900)}`;
    const started = cpuMs();
    for (let i = 0; i < 30; i += 1) expect(links(hostile)[0]!.text).toBe("https://example.com/");
    expect(cpuMs() - started).toBeLessThan(500);
  });

  it("isolates each link left to right, so direction marks around it cannot reverse what it shows", () => {
    const p = render("\u202ehttps://moc.it//:sptth\u202c");
    expect(p.querySelector("a")!.getAttribute("dir")).toBe("ltr");
  });

  it("links nothing but https: no javascript:, data:, http:, bare domains or a bare scheme", () => {
    for (const text of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "http://example.com",
      "example.com and www.example.com",
      "https://",
      "https:///path",
      "https://\\evil.example",
      "ftp://example.com",
      "xhttps://example.com",
      "javascript://https://example.com%0Aalert(1)",
    ])
      expect(links(text), text).toEqual([]);
  });

  it("never parses the text as HTML, so markup in or around a URL stays text", () => {
    const hostile = 'https://example.com/"><img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>';
    const p = render(hostile);
    expect(p.textContent).toBe(hostile);
    expect(p.querySelector("img")).toBeNull();
    expect([...p.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com/"]);
  });

  it("refuses a URL with a user name or password, which can disguise the real host", () => {
    expect(links("https://github.com@evil.example/login")).toEqual([]);
    expect(links("https://user:pass@example.com/")).toEqual([]);
  });

  it("stops a URL at invisible and direction-changing marks, so a link cannot hide or reorder what it shows", () => {
    expect(links("https://example.com/‮gnp.exe")[0]!.text).toBe("https://example.com/");
    expect(links("https://example.com/a​b")[0]!.text).toBe("https://example.com/a");
    expect(links("https://exa\u0000mple.com")[0]?.text).toBe("https://exa");
  });

  it("does not link a URL past 2048 characters, and keeps it as text", () => {
    const long = `https://example.com/${"a".repeat(2100)}`;
    const p = render(long);
    expect(p.querySelector("a")).toBeNull();
    expect(p.textContent).toBe(long);
  });

  it("links an upper-case scheme to its normal form, and a host in another script as its encoded form", () => {
    expect(links("HTTPS://Example.com/A")).toEqual([{ href: "https://example.com/A", text: "HTTPS://Example.com/A" }]);
    expect(links("https://bücher.example/")[0]!.href).toBe("https://xn--bcher-kva.example/");
  });

  it("returns plain text unchanged when there is no URL", () => {
    expect(linkify("")).toEqual([]);
    expect(linkify("no links here")).toEqual(["no links here"]);
  });
});
