// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { APP_NAME, STORED_NAME } from "../src/shared/names.js";
import { probeCloud, resetCloud } from "../web/src/cloud-agent.js";
import { keepFocus } from "../web/src/dom.js";
import { showRivetWords, TYPED } from "../web/src/rivet-words.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  document.body.replaceChildren();
});

describe("showRivetWords", () => {
  it("leaves his own typed words as typed, on the page and as they arrive, and still fixes the line beside them", async () => {
    document.body.innerHTML = `<p id="mine" data-typed>Clean up Rivet's mind</p><p id="theirs">Rivet here</p>`;
    stop = showRivetWords();
    expect(document.getElementById("mine")!.textContent).toBe("Clean up Rivet's mind");
    expect(document.getElementById("theirs")!.textContent).toBe("Rivet here");

    const quote = document.createElement("span");
    quote.setAttribute(TYPED, "");
    quote.innerHTML = "I said <b>RIVET</b>";
    document.body.append(quote);
    const text = document.getElementById("mine")!.firstChild as Text;
    text.data = "Rivet again";
    await flush();
    expect(quote.textContent).toBe("I said RIVET");
    expect(text.data).toBe("Rivet again");
  });

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

describe("showRivetWords on a hosted machine", () => {
  const host = async (name: string, app?: string) => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ name, setupDone: true, firstPlan: "claude", app }), { status: 200, headers: { "content-type": "application/json" } }))));
    await probeCloud();
  };

  afterEach(() => {
    resetCloud();
    vi.unstubAllGlobals();
  });

  it("shows an agent named with the old name as the unnamed agent, on the page, as it arrives and in its labels", async () => {
    await host("Rivet Jr");
    document.body.innerHTML = `<h1 id="title">Rivet Jr</h1><p id="note">Rivet Jr's mind, from Rivet Ops</p>`;
    stop = showRivetWords();
    expect(document.getElementById("title")!.textContent).toBe("Agent Jr");
    expect(document.getElementById("note")!.textContent).toBe("Agent Jr's mind, from Agent Ops");

    const button = document.createElement("button");
    button.setAttribute("aria-label", "Message Rivet Jr");
    button.textContent = "Rivet Jr's chat";
    document.body.append(button);
    await flush();
    expect(button.getAttribute("aria-label")).toBe("Message Agent Jr");
    expect(button.textContent).toBe("Agent Jr's chat");
  });

  it("names the words drawn before the probe once it names the agent, and settles", async () => {
    document.body.innerHTML = `<h1>Message ${STORED_NAME}</h1><p>Updates from ${STORED_NAME}</p><button aria-label="Ask ${STORED_NAME}">Rivet is on it</button><span>${APP_NAME}</span>`;
    stop = showRivetWords();
    expect(document.body.textContent).toMatch(new RegExp(STORED_NAME));
    let writes = 0;
    const count = new MutationObserver((records) => (writes += records.length));
    count.observe(document.body, { subtree: true, characterData: true, attributes: true });
    await host("Pip", "Acme Cloud");
    for (let i = 0; i < 5; i += 1) await flush();
    expect(document.body.textContent + document.body.innerHTML).not.toMatch(new RegExp(`${STORED_NAME}|Rivet`, "i"));
    expect([...document.body.children].map((node) => node.textContent)).toEqual(["Message Pip", "Updates from Pip", "Pip is on it", "Acme Cloud"]);
    expect(document.querySelector("button")!.getAttribute("aria-label")).toBe("Ask Pip");
    const settled = writes;
    for (let i = 0; i < 5; i += 1) await flush();
    expect(writes).toBe(settled);
    count.disconnect();
  });

  it("never splits the old name on a short agent name", async () => {
    await host("Ha");
    document.body.innerHTML = `<p id="note">Rivet is on it, Ha says</p>`;
    stop = showRivetWords();
    expect(document.getElementById("note")!.textContent).toBe("Ha is on it, Ha says");
  });

  it("keeps the app's name a product's, never the agent's, and names it as the host does", async () => {
    await host("Pip");
    document.body.innerHTML = `<p id="note">${APP_NAME}: Rivet is on it</p>`;
    stop = showRivetWords();
    expect(document.getElementById("note")!.textContent).toBe(`${APP_NAME}: Pip is on it`);
    stop?.();
    resetCloud();
    await host("Pip", "Acme Agents");
    document.body.innerHTML = `<p id="note">${APP_NAME}: Rivet is on it</p>`;
    stop = showRivetWords();
    expect(document.getElementById("note")!.textContent).toBe("Acme Agents: Pip is on it");
  });

  it("settles on an all-caps old name for an agent named with the old name, in text and labels, never growing", async () => {
    await host("Rivet Jr");
    document.body.innerHTML = `<p id="note">RIVET is restarting</p><button id="b" title="éRivet and RIVET">x</button>`;
    stop = showRivetWords();
    const note = document.getElementById("note")!;
    note.firstChild!.textContent = "RIVET is on it";
    for (let i = 0; i < 5; i += 1) await flush();
    expect(note.textContent).toBe("AGENT is on it");
    expect(document.getElementById("b")!.getAttribute("title")).toBe("éRivet and AGENT");
  });

  it("still says Rivet for the old name on the owner's own machine", () => {
    document.body.innerHTML = `<h1 id="title">Rivet Jr</h1>`;
    stop = showRivetWords();
    expect(document.getElementById("title")!.textContent).toBe("Rivet Jr");
  });

  const storedLines = `<p>Updates from ${STORED_NAME}</p><p>${STORED_NAME} picked this up on its own</p><button>Ask ${STORED_NAME} to fix</button><span>Last updated 2m ago by ${STORED_NAME}</span>`;

  it("shows stored lines with the stored name as the agent's name, on the page and as they arrive", async () => {
    await host("Pip", "Acme Cloud");
    document.body.innerHTML = storedLines;
    stop = showRivetWords();
    const late = document.createElement("p");
    late.textContent = `${STORED_NAME} is waiting up to 30 minutes`;
    document.body.append(late);
    await flush();
    expect(document.body.textContent).not.toMatch(new RegExp(STORED_NAME, "i"));
    expect([...document.body.children].map((node) => node.textContent)).toEqual([
      "Updates from Pip",
      "Pip picked this up on its own",
      "Ask Pip to fix",
      "Last updated 2m ago by Pip",
      "Pip is waiting up to 30 minutes",
    ]);
  });

  it("leaves stored lines as written on the owner's own machine", () => {
    document.body.innerHTML = storedLines;
    stop = showRivetWords();
    expect(document.body.innerHTML).toBe(storedLines);
  });

  it("settles after one write per change for an accepted app name, and writes nothing for a refused one", async () => {
    let writes = 0;
    const count = new MutationObserver((records) => (writes += records.filter((record) => record.type === "characterData").length));
    count.observe(document.body, { subtree: true, characterData: true });
    for (const [app, shown] of [["Pip Cloud", "Pip Cloud: Pip is on it, from Pip"], [`${APP_NAME} Cloud`, `${APP_NAME}: Pip is on it, from Pip`]] as const) {
      resetCloud();
      await host("Pip", app);
      document.body.innerHTML = `<p id="note">x</p>`;
      stop = showRivetWords(document.body);
      writes = 0;
      document.getElementById("note")!.firstChild!.textContent = `${APP_NAME}: Rivet is on it, from ${STORED_NAME}`;
      for (let i = 0; i < 10; i += 1) await flush();
      expect(document.getElementById("note")!.textContent, app).toBe(shown);
      expect(writes, app).toBe(2);
      stop();
    }
    count.disconnect();
  });
});
