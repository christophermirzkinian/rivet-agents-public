import { h } from "../dom.js";

// The desktop's keyboard help, opened with "?".

const GROUPS: [string, [string[], string][]][] = [
  [
    "Decide",
    [
      [["J", "K"], "Next or previous card"],
      [["Space"], "Play the card's clips"],
      [["A"], "Approve"],
      [["1–9"], "Choose an option"],
      [["C"], "Write a comment"],
      [["⌘", "↵"], "Send the comment or answer"],
      [["X"], "Reject"],
      [["L"], "Minimise the card"],
      [["Z"], "Undo the last answer"],
      [["↵"], "Confirm a money, auth or fairness answer"],
    ],
  ],
  [
    "Panes",
    [
      [["]"], "Show or collapse chat"],
      [["\\"], "Labels or icons on the left rail"],
      [["F"], "Focus: the card alone"],
    ],
  ],
  [
    "Anywhere",
    [
      [["/"], "Search"],
      [["?"], "This list"],
      [["Esc"], "Close"],
    ],
  ],
];

export function mount(el: HTMLElement): void {
  el.replaceChildren(
    h(
      "div",
      { class: "shortcuts" },
      ...GROUPS.map(([title, rows]) =>
        h(
          "section",
          { class: "shortcuts-group" },
          h("h3", { class: "shortcuts-title" }, title),
          h(
            "dl",
            { class: "shortcuts-list" },
            ...rows.flatMap(([keys, label]) => [
              h("dt", {}, ...keys.map((key) => h("kbd", { class: "key" }, key))),
              h("dd", {}, label),
            ]),
          ),
        ),
      ),
      h("p", { class: "shortcuts-note" }, "Drag a pane's inner edge to resize it; double-click the edge to reset. The layout is kept on this device."),
    ),
  );
}

export function unmount(): void {}
