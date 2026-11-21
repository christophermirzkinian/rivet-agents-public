import { afterEach, describe, expect, it } from "vitest";

import { APP_NAME, chatName, checkedAgentName, checkedAppName, RIVET_NAME, nameHostedAgent, rivetWords, STORED_NAME, UNNAMED_AGENT } from "../src/shared/names.js";

describe("chatName", () => {
  it("reads the monitor's chat as Rivet and a chat named for the old name with rivet", () => {
    expect(chatName("rivet")).toBe("Rivet");
    expect(chatName("rivet-coming")).toBe("rivet-coming");
    expect(chatName("ops-rivet-v2")).toBe("ops-rivet-v2");
    expect(chatName("rivetian")).toBe("rivetian");
  });

  it("puts a hosted agent's name in as it is spelt, never as a replacement pattern", () => {
    nameHostedAgent("A$&b$'");
    expect(chatName("rivet-coming")).toBe("a$&b$'-coming");
    nameHostedAgent(null);
    expect(chatName("rivet-coming")).toBe("rivet-coming");
  });
});

describe("rivetWords", () => {
  afterEach(() => nameHostedAgent(null));

  it("renames the old name in any case and never renames a name with the old name in it again", () => {
    nameHostedAgent("Rivet Jr");
    expect(rivetWords("RIVET is restarting")).toBe("RIVET JR is restarting");
    expect(rivetWords("Rivet is on it")).toBe("Rivet Jr is on it");
    expect(rivetWords("Rivet Jr and RIVET JR are on it")).toBe("Rivet Jr and RIVET JR are on it");
    nameHostedAgent("Rivetta");
    expect(rivetWords("Rivet and Rivetta")).toBe("Rivetta and Rivetta");
  });

  it("is done in one pass: a second changes nothing", () => {
    const texts = ["Rivet is on it", "RIVET is restarting", "Rivet Jr said Rivet's line", "RIVET and RIVET JR", "éRivet and Rivet", `${APP_NAME} · Rivet`];
    for (const name of [null, "Rivet Jr", "Rivetta", "Big Rivet", "Ha", "RIVET-bot", "Pip"]) {
      nameHostedAgent(name, name ? "Acme Agents" : null);
      for (const text of texts) expect(rivetWords(rivetWords(text)), `${name}: ${text}`).toBe(rivetWords(text));
    }
  });

  it("refuses an app name with the build's app name, its stored name or the old name in it", () => {
    for (const app of [`${APP_NAME} Cloud`, `${STORED_NAME} Cloud`, "Rivet Cloud", "rivet agents cloud", "RIVET", APP_NAME]) expect(checkedAppName(app), app).toBeNull();
    expect(checkedAppName(" Acme Cloud ")).toBe("Acme Cloud");
  });

  it("refuses an agent name with the build's app name, its stored name or the old name in it as a word, in any case", () => {
    for (const name of ["Rivet and Bolt", "rivet and bolt", "Acme Rivet", "Pip RIVET", "rivet jr", "Rivet", `${APP_NAME} Pip`, "Rivet-Bolt"]) expect(checkedAgentName(name), name).toBeNull();
    for (const name of ["Pip", "Rivetta", "Rivetyun", "Bolt"]) expect(checkedAgentName(name), name).toBe(name);
  });

  it("settles in one pass for an agent and an app as the server and the app take them, the unnamed agent for a refused name", () => {
    const pairs = [["Rivet and Bolt", "Bolt"], ["Acme Rivet", "Acme"], ["Rivetbolt", "bolt"], ["Rivetbolt", "BOLT"], ["Pip", "Pip Cloud"], ["Bolt Pip", "Bolt"], ["Rivetta", "etta"], ["Rivetyun", "yun"], ["Pip", "Acme Agents"], ["Agent", "Agents"]];
    const texts = ["Rivet and Bolt", "Acme Rivet", "Rivetbolt", `${APP_NAME} · Rivet is on it`, "RIVET and RIVET", `Updates from ${STORED_NAME}`, "Bolt Pip and Rivet", "Rivetyun"];
    for (const [raw, rawApp] of pairs) {
      nameHostedAgent(checkedAgentName(raw) ?? UNNAMED_AGENT, checkedAppName(rawApp));
      for (const text of texts) {
        const once = rivetWords(text);
        expect(rivetWords(once), `${raw} ${rawApp}: ${text}`).toBe(once);
      }
    }
    nameHostedAgent(checkedAgentName("Rivet and Bolt") ?? UNNAMED_AGENT, checkedAppName("Bolt"));
    expect(RIVET_NAME).toBe(UNNAMED_AGENT);
    expect(rivetWords("Rivet and Bolt")).toBe("Agent and Bolt");
  });

  it("keeps an accepted app name and the words it wrote the same on a second and a third pass", () => {
    const texts = [`${APP_NAME} · Rivet`, `${STORED_NAME} is on it`, "Acme Cloud · RIVET", "CloudRivet and Cloud Rivet", `${APP_NAME} Cloud`];
    for (const app of ["Acme Cloud", "Cloud", "Pip Cloud", "Agents"]) {
      for (const name of [null, "Pip", "Pip Cloud"]) {
        nameHostedAgent(name, checkedAppName(app));
        for (const text of texts) {
          const once = rivetWords(text);
          expect(rivetWords(once), `${name} ${app}: ${text}`).toBe(once);
          expect(rivetWords(rivetWords(once)), `${name} ${app}: ${text}`).toBe(once);
        }
      }
    }
  });

  it("shows the stored name as a hosted agent's name, and as written on the owner's machine", () => {
    const stored = [`Updates from ${STORED_NAME}`, `Ask ${STORED_NAME} to fix`, `Last updated 2m ago by ${STORED_NAME}`, `${STORED_NAME.toUpperCase()} picked this up`];
    for (const text of stored) expect(rivetWords(text)).toBe(text);
    nameHostedAgent("Pip", "Acme Cloud");
    expect(stored.map(rivetWords)).toEqual(["Updates from Pip", "Ask Pip to fix", "Last updated 2m ago by Pip", "PIP picked this up"]);
    expect(rivetWords(`rivet-${STORED_NAME.toLowerCase()} and ${STORED_NAME.toUpperCase()}_TOKEN`)).toBe(`rivet-${STORED_NAME.toLowerCase()} and ${STORED_NAME.toUpperCase()}_TOKEN`);
  });

  it("names the agent and leaves the app's name a product's", () => {
    expect(rivetWords(`${APP_NAME} · Rivet is on it`)).toBe(`${APP_NAME} · Rivet is on it`);
    nameHostedAgent("Pip");
    expect(rivetWords(`${APP_NAME} · Rivet is on it`)).toBe(`${APP_NAME} · Pip is on it`);
    nameHostedAgent("Pip", "Acme Agents");
    expect(rivetWords(`${APP_NAME} · Rivet is on it`)).toBe("Acme Agents · Pip is on it");
  });
});
