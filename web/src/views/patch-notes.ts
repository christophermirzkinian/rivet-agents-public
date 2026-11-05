import type { TimelineEvent, TimelineResponse } from "../../../src/shared/ops.js";
import * as api from "../api.js";
import { describe, h, isHttps } from "../dom.js";
import { opsData } from "../ops-data.js";
import { when } from "../../../src/shared/when.js";

// Settings → Patch notes: what each deploy shipped, in plain words from the merged PR titles. Built from the Ops
// timeline: each PR joins the release whose git ancestry proves it newly shipped.

export interface PatchNote {
  text: string;
  number?: number;
  url?: string;
}

export interface PatchDeploy {
  at: string;
  title: string;
  notes: PatchNote[];
}

/** "chat threads (#12)" → "Chat threads". */
export function noteText(title: string): string {
  const text = title.replace(/\s*\(#\d+(?:,\s*#\d+)*\)/g, "").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Deploys newest first, each with the PRs it shipped; deploys with nothing to say are left out. */
export function patchNotes(timeline: TimelineResponse | null): PatchDeploy[] {
  const events = (Array.isArray(timeline?.days) ? timeline.days : []).flatMap((day) => (Array.isArray(day?.events) ? day.events : []));
  const time = (event: TimelineEvent) => (typeof event.at === "string" ? Date.parse(event.at) : NaN);
  const deploys = events
    .filter((event) => event.kind === "deploy" && Number.isFinite(time(event)))
    .sort((a, b) => time(a) - time(b))
    .map((event) => ({ event, notes: [] as (PatchNote & { at: number })[] }));
  for (const pr of events) {
    if (pr.kind !== "merged" || typeof pr.title !== "string" || !Number.isFinite(time(pr))) continue;
    // Release evidence already accounts for the baseline, unknown history and redeploys.
    const deploy = typeof pr.mergeSha === "string"
      ? deploys.find((d) => d.event.patchMerges?.includes(pr.mergeSha!)) : undefined;
    const text = noteText(pr.title);
    if (!deploy || !text) continue;
    deploy.notes.push({
      text,
      at: time(pr),
      ...(typeof pr.number === "number" ? { number: pr.number } : {}),
      ...(typeof pr.url === "string" && isHttps(pr.url) ? { url: pr.url } : {}),
    });
  }
  return deploys
    .filter((d) => d.notes.length)
    .reverse()
    .map((d) => ({
      at: d.event.at as string,
      title: String(d.event.title),
      notes: d.notes.sort((a, b) => a.at - b.at).map(({ at: _at, ...note }) => note),
    }));
}

export function patchNotesBody(deploys: PatchDeploy[], loaded: boolean): HTMLElement {
  if (!deploys.length) {
    return h("p", { class: "empty" }, loaded ? "Nothing was deployed in the last 14 days." : "Loading the patch notes…");
  }
  return h(
    "div",
    { class: "ops-days" },
    ...deploys.map((deploy) =>
      h(
        "div",
        { class: "ops-day" },
        h("h3", { class: "ops-sub" }, `${when(deploy.at)} · ${deploy.title}`),
        h(
          "ul",
          { class: "ops-rows" },
          ...deploy.notes.map((note) => {
            const body = h("span", { class: "ops-row-title" }, note.number ? h("span", { class: "ops-num" }, `#${note.number}`) : null, note.text);
            return h(
              "li",
              { class: "ops-row box s-ok" },
              note.url
                ? h("a", { class: "ops-link", attrs: { href: note.url, target: "_blank", rel: "noopener noreferrer", "data-use": "patch-notes.link" } }, body)
                : h("span", { class: "ops-link" }, body),
            );
          }),
        ),
      ),
    ),
  );
}

/** The sheet Settings opens: the timeline Ops already holds, or a fresh read of it. */
let reads = 0;

export function mount(el: HTMLElement): void {
  const read = ++reads;
  const show = (timeline: TimelineResponse | null, error?: string) => {
    if (read !== reads) return;
    el.replaceChildren(
      h("p", { class: "panel-text" }, "What each deploy in the last 14 days shipped."),
      error ? h("p", { class: "empty" }, `Patch notes did not load: ${error}`) : patchNotesBody(patchNotes(timeline), timeline !== null),
    );
  };
  show(opsData.timeline);
  api.getTimeline().then(
    (timeline) => show(timeline),
    // Ops may have loaded the timeline meanwhile: show that rather than an error or a stuck "Loading".
    (error: unknown) => show(opsData.timeline, opsData.timeline ? undefined : describe(error)),
  );
}

export function unmount(): void {
  reads += 1;
}
