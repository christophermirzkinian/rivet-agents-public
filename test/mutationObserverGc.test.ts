// @vitest-environment happy-dom
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

// A garbage collection on demand, without starting Node with --expose-gc.
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

it("an observer still reports after a garbage collection, as in a browser (vitest.setup.ts)", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const seen: string[] = [];
  new MutationObserver((records) => seen.push(...records.map((record) => record.attributeName ?? ""))).observe(host, { attributes: true });
  // A WeakRef made in this job keeps its target until the job ends, so collect on a later turn.
  await turn();
  gc();
  host.setAttribute("data-art", "1");
  await turn();
  expect(seen).toEqual(["data-art"]);
});
