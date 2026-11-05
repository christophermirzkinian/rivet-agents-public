// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../src/shared/command.js";
import { TEAM_ROOM_ID } from "../src/shared/conversations.js";
import { detailBody, EMPTY_LIST } from "./conversations-fake.js";

vi.mock("../web/src/voice.js", async (original) => ({
  ...(await original<typeof import("../web/src/voice.js")>()),
  say: () => {},
  unlockVoice: () => Promise.resolve(true),
  unlockOnTap: () => () => {},
  stopVoice: () => {},
}));

const chat = await import("../web/src/views/chat.js");

let n = 0;
const line = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${++n}`,
  from: "rivet",
  text,
  at: new Date(Date.UTC(2030, 0, 1, 0, 0, n)).toISOString(),
  threadId: TEAM_ROOM_ID,
  ...extra,
});
const room = [
  line("board up", { team: { from: "kanban", to: "lead" } }),
  line("cover video ready", { team: { from: "cover-video", to: "lead" } }),
  line("kanban: rebase on main", { from: "owner" }),
  line("lead to kanban: go", {
    team: { from: "lead", to: "kanban" },
  }),
  line("looks good", { from: "owner" }),
];
room.push(line("thanks", { from: "owner", replyTo: room[0]!.id }));
room.push(line("you're welcome", { replyTo: room.at(-1)!.id }));

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return json(
    new URL(String(input), "http://x").pathname.startsWith(
      "/api/conversations/",
    )
      ? detailBody(TEAM_ROOM_ID, room)
      : EMPTY_LIST,
  );
}

class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  addEventListener() {}
  close() {}
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};
let root: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.stubGlobal("EventSource", FakeSource);
  localStorage.clear();
  root = document.createElement("main");
  document.body.replaceChildren(root);
});

afterEach(() => {
  chat.unmount();
  vi.unstubAllGlobals();
});

describe("the Team room", () => {
  it("opens an empty room, not a gone one, before any agent has written there", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        new URL(String(input), "http://x").pathname.startsWith(
          "/api/conversations/",
        )
          ? new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify(EMPTY_LIST), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      ),
    );
    chat.showConversation(TEAM_ROOM_ID);
    chat.mount(root);
    await settle();
    expect(root.querySelector(".chat-empty")?.textContent).toBe(
      "No agent has written here yet.",
    );
    expect(
      root.querySelector(".chat-compose-box")?.hasAttribute("hidden"),
    ).toBe(true);
  });
});
