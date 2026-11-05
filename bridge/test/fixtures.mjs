/** A valid reply as the server streams it; override fields per test. */
export function reply(overrides = {}, itemOverrides = {}) {
  return {
    id: "r_01",
    itemId: "pr2022-website",
    itemTitle: "Website: dark mode on the settings page",
    decision: "approve",
    at: "2026-09-28T01:02:03.000Z",
    handled: false,
    ...overrides,
    item: {
      id: "pr2022-website",
      title: "Website: dark mode on the settings page",
      kind: "approval",
      chat: "website-dark-mode",
      pr: 2022,
      ...itemOverrides,
    },
  };
}
