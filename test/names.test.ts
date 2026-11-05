import { describe, expect, it } from "vitest";

import { chatName } from "../src/shared/names.js";

describe("chatName", () => {
  it("reads the monitor's chat as Rivet and a chat named for the old name with rivet", () => {
    expect(chatName("rivet")).toBe("Rivet");
    expect(chatName("rivet-coming")).toBe("rivet-coming");
    expect(chatName("ops-rivet-v2")).toBe("ops-rivet-v2");
    expect(chatName("rivetian")).toBe("rivetian");
  });
});
