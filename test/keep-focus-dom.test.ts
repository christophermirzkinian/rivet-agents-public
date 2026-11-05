// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { keepFocus } from "../web/src/dom.js";

afterEach(() => document.body.replaceChildren());

/** A root holding one card at `rev`, with its answer button in `tone`. */
function draw(root: HTMLElement, rev: string, tone: string): HTMLButtonElement {
  const card = document.createElement("div");
  card.setAttribute("data-need", "a");
  card.setAttribute("data-rev", rev);
  const answer = document.createElement("button");
  answer.className = `answer t-${tone}`;
  answer.setAttribute("data-key", "wait-a-day");
  answer.textContent = "Wait a day";
  card.append(answer);
  root.replaceChildren(card);
  return answer;
}

describe("keepFocus across a redraw that changes a control's class", () => {
  it("finds the same control, by its whole name, in its new tone", () => {
    const root = document.body.appendChild(document.createElement("div"));
    draw(root, "r1", "ok").focus();
    const refocus = keepFocus(root);
    const next = draw(root, "r1", "warn");
    refocus();
    expect(document.activeElement).toBe(next);
  });

  it("never lands on a newer revision's answer, whose card is another", () => {
    const root = document.body.appendChild(document.createElement("div"));
    draw(root, "r1", "ok").focus();
    const refocus = keepFocus(root);
    const next = draw(root, "r2", "warn");
    refocus();
    expect(document.activeElement).not.toBe(next);
  });

  it("puts the keyboard back on a control moved out and back in", () => {
    const root = document.body.appendChild(document.createElement("div"));
    const kept = draw(root, "r1", "ok");
    kept.focus();
    const refocus = keepFocus(root);
    const card = root.firstElementChild!;
    root.replaceChildren();
    root.append(card);
    refocus();
    expect(document.activeElement).toBe(kept);
  });

  it("keeps the keyboard on the Answered row it was on, though another row reads the same (review R2, slice 5)", () => {
    const root = document.body.appendChild(document.createElement("div"));
    const rows = () => {
      root.replaceChildren(
        ...["r-a", "r-b"].map((reply) => {
          const row = document.createElement("div");
          row.className = "ans-row";
          row.setAttribute("data-reply", reply);
          const reopen = document.createElement("button");
          reopen.className = "btn";
          reopen.textContent = "Reopen";
          row.append(reopen);
          return row;
        }),
      );
      return [...root.querySelectorAll<HTMLButtonElement>("button")];
    };
    rows()[1]!.focus();
    const refocus = keepFocus(root);
    const next = rows();
    refocus();
    expect(document.activeElement).toBe(next[1]);
  });
});
