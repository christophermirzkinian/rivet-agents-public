// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";

import { app, resetSession } from "../web/src/state.js";
import { searchSources } from "../web/src/views/search.js";

afterEach(() => {
  resetSession();
});

it("the board's chat results key two repos' chats sharing a name apart, so both are found", async () => {
  const markets = "example-org/example-markets";
  app.board = {
    board: {
      updatedAt: "x",
      needs: [],
      shipped: [],
      coming: [],
      chats: [
        { name: "rates", state: "x", prs: [42], repo: "example-org/example-repo" },
        { name: "rates", state: "x", prs: [42], repo: markets },
      ],
    },
  } as never;
  const chats = (await searchSources.get("board")!("")).filter((item) => item.kind === "chat");
  expect(chats.map((item) => item.key)).toEqual(["chat:example-org/example-repo/rates", `chat:${markets}/rates`]);
});
