import { chatName } from "../../../src/shared/names.js";
import "./command.css";

import type { AuditEntry } from "../../../src/shared/command.js";
import { maybeWhen } from "../../../src/shared/when.js";
import { h } from "../dom.js";

// The recent actions list Ops shows: what was sent to the Mac and where each stands.

const KIND_WORDS: Record<AuditEntry["kind"], string> = {
  chat: "Chat",
  send: "Sent to chat",
  pause: "Pause",
  merge: "Merge",
  schedule: "Schedule switch",
  issue: "On GitHub",
  job: "Scheduled job",
};

const STATUS_WORDS: Record<AuditEntry["status"], string> = {
  collecting: "Collecting",
  queued: "Waiting for the Mac",
  typed: "Typed",
  unconfirmed: "Typed, not confirmed",
  replied: "Replied",
  previewed: "Checked",
  refused: "Refused",
  merged: "Merged",
  armed: "Merging when checks pass",
  deploying: "Deploying",
  deployed: "Deployed",
  dispatched: "Started",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  untracked: "Started, not tracked",
};

function statusChip(status: AuditEntry["status"]): HTMLElement {
  return h("span", { class: `cmd-chip ${status}` }, STATUS_WORDS[status]);
}

function summary(entry: AuditEntry): string {
  switch (entry.kind) {
    case "merge":
      return `PR #${entry.pr}`;
    case "send":
    case "pause":
      return entry.chat ? chatName(entry.chat) : "";
    case "schedule":
      return `${entry.on ? "On" : "Off"}: ${entry.schedule ?? ""}`;
    case "issue":
      return `${entry.op === "close" ? "Close" : "Comment on"} #${entry.issue ?? ""}`;
    default:
      return entry.text ? (entry.text.length > 60 ? `${entry.text.slice(0, 59)}…` : entry.text) : "";
  }
}

/** The recent actions list, newest first. */
export function auditList(entries: AuditEntry[]): HTMLElement {
  if (!entries.length) return h("p", { class: "cmd-meta" }, "No actions yet.");
  return h(
    "ul",
    { class: "cmd-audit" },
    ...entries.map((entry) =>
      h(
        "li",
        { class: "cmd-audit-row box" },
        h("span", { class: "cmd-audit-kind" }, KIND_WORDS[entry.kind]),
        h("span", { class: "cmd-audit-what" }, summary(entry)),
        statusChip(entry.status),
        h("span", { class: "cmd-meta" }, maybeWhen(entry.updatedAt) ?? ""),
      ),
    ),
  );
}
