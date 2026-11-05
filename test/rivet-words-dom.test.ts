// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { keepFocus } from "../web/src/dom.js";
import { showRivetWords } from "../web/src/rivet-words.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  document.body.replaceChildren();
});

describe("showRivetWords", () => {
  it("shows a PR title, a note and a label with the old name as Rivet, on the page and as it changes", async () => {
    document.body.innerHTML = `<p id="title">#6511 Rivet notes: a hold card</p>`;
    stop = showRivetWords();
    expect(document.getElementById("title")!.textContent).toBe(
      "#6511 Rivet notes: a hold card",
    );

    const card = document.createElement("article");
    card.innerHTML = `<h2>Rivet's pick</h2><button aria-label="Message Rivet" title="RIVET">x</button>`;
    document.body.append(card);
    const note = document.createElement("p");
    note.textContent = "first";
    document.body.append(note);
    await flush();
    note.firstChild!.textContent = "Rivet is opening a chat on it.";
    card.querySelector("button")!.setAttribute("title", "Ask Rivet");
    await flush();

    expect(card.querySelector("h2")!.textContent).toBe("Rivet's pick");
    expect(card.querySelector("button")!.getAttribute("aria-label")).toBe(
      "Message Rivet",
    );
    expect(card.querySelector("button")!.getAttribute("title")).toBe(
      "Ask Rivet",
    );
    expect(note.textContent).toBe("Rivet is opening a chat on it.");
  });

  it("leaves hostnames, commands and what you is typing alone", async () => {
    stop = showRivetWords();
    const box = document.createElement("textarea");
    box.textContent = "Tell Rivet";
    const line = document.createElement("p");
    line.textContent = "rivet.example.com · rivet claim list";
    document.body.append(box, line);
    await flush();
    expect(box.textContent).toBe("Tell Rivet");
    expect(line.textContent).toBe("rivet.example.com · rivet claim list");
  });

  it("leaves code and a link's address alone, and reads a plain-text document", async () => {
    stop = showRivetWords();
    const line = document.createElement("p");
    line.innerHTML = `Ran <code>Rivet claim</code>, see <a href="https://github.com/search?q=Rivet">https://github.com/search?q=Rivet</a>`;
    const doc = document.createElement("pre");
    doc.textContent = "Rivet is opening the next chat";
    document.body.append(line, doc);
    await flush();
    expect(line.textContent).toBe(
      "Ran Rivet claim, see https://github.com/search?q=Rivet",
    );
    expect(doc.textContent).toBe("Rivet is opening the next chat");
  });

  it("keeps the keyboard on a control the page showed as Rivet when a redraw brings it back with the old name", async () => {
    const list = document.createElement("div");
    list.innerHTML = `<button type="button" class="link">Rivet notes: a hold card</button>`;
    document.body.append(list);
    stop = showRivetWords();
    const was = list.querySelector("button")!;
    was.focus();
    expect(was.textContent).toBe("Rivet notes: a hold card");

    const refocus = keepFocus(list);
    list.innerHTML = `<button type="button" class="link">Rivet notes: a hold card</button>`;
    refocus();
    expect(document.activeElement).toBe(list.querySelector("button"));
  });
});
