#!/usr/bin/env node
// Stop: warns a chat when its work belongs to another project: every file it changed in its own
// repo sits in another repo's project, or it has changed nothing here while editing another project's files for
// ELSEWHERE_MS. A warning only, at most once an hour per chat; any failure of its own says nothing.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { loadProjects, projectsFromFolders } from "../../bridge/lib/projects.mjs";
import { routeChat } from "../../bridge/lib/route-chat.mjs";
import { advisory, emit, readStdin, tailLines } from "./lib.mjs";

const HOUR_MS = 3_600_000;
export const ELSEWHERE_MS = 20 * 60_000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CHAT_NAME = /^[A-Za-z0-9._-]{1,100}$/;

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
const lines = (text) => text.split("\n").filter(Boolean);

/** The repo-relative files a worktree changed: committed since its base, staged, unstaged and untracked. */
export function changedFiles(root) {
  const files = new Set(lines(git(root, ["ls-files", "--others", "--exclude-standard"])));
  for (const file of lines(git(root, ["diff", "--name-only", "HEAD"]))) files.add(file);
  for (const ref of ["origin/main", "main"]) {
    let base;
    try {
      base = git(root, ["merge-base", "HEAD", ref]);
    } catch {
      continue;
    }
    for (const file of lines(git(root, ["diff", "--name-only", base, "HEAD"]))) files.add(file);
    break;
  }
  return [...files];
}

/** The files the transcript's edit tools wrote outside `root`, each with when. */
export function editsOutside(transcript, root) {
  const edits = [];
  for (const line of transcript) {
    if (!line.includes('"tool_use"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(entry?.timestamp ?? "");
    const parts = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    for (const part of parts) {
      if (part?.type !== "tool_use" || !EDIT_TOOLS.has(part.name)) continue;
      const file = part.input?.file_path ?? part.input?.notebook_path;
      if (typeof file !== "string" || !isAbsolute(file)) continue;
      const rel = relative(root, file);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) continue;
      edits.push({ file, at });
    }
  }
  return edits;
}

/** The project of the most entries, list order on a tie. */
function most(found, projects) {
  const count = new Map();
  for (const project of found) count.set(project.id, (count.get(project.id) ?? 0) + 1);
  const best = Math.max(...count.values());
  return projects.find((project) => count.get(project.id) === best);
}

/**
 * The warning for a chat at `root`, or null. A path's project is the router's sure answer for that path alone; a file
 * in a project of the chat's own repo (a product folder) is the chat's own.
 */
export function routingWarning({ root, changed, edits, projects, worktreeRoots, now }) {
  const ownerOf = (path) => {
    const routed = routeChat({ ask: "", paths: [path], unattended: true }, { projects, worktreeRoots });
    return routed.sure ? projects.find((project) => project.id === routed.project) : undefined;
  };
  const home = ownerOf(root);
  if (!home) return null;
  const away = (path) => {
    const owner = ownerOf(path);
    return owner && owner.workspaceRepo !== home.workspaceRepo ? owner : null;
  };
  if (changed.length) {
    const owners = changed.map(away);
    if (owners.some((owner) => !owner)) return null;
    const target = most(owners, projects);
    return { home, target, why: `every file this chat changed (${changed.length}) sits in ${target.name}, not in ${home.name}` };
  }
  const elsewhere = edits.map((edit) => ({ ...edit, to: away(edit.file) })).filter((edit) => edit.to && Number.isFinite(edit.at));
  if (!elsewhere.length) return null;
  const first = Math.min(...elsewhere.map((edit) => edit.at));
  if (now - first < ELSEWHERE_MS) return null;
  const target = most(elsewhere.map((edit) => edit.to), projects);
  const minutes = Math.floor((now - first) / 60_000);
  return { home, target, why: `this chat has changed nothing in ${home.name} and has edited ${target.name}'s files for ${minutes} minutes` };
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const input = await readStdin();
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!dir) return;
  const root = git(dir, ["rev-parse", "--show-toplevel"]);
  const chat = basename(root);
  if (!CHAT_NAME.test(chat)) return;
  const stateDir = join(homedir(), ".rivet", "chat-routing");
  const statePath = join(stateDir, `${chat}.json`);
  const now = Date.now();
  if (now - (readState(statePath).warnedAt ?? 0) < HOUR_MS) return;
  const listed = loadProjects();
  // No project list (the public tree): every folder beside the chat's repo is a project.
  const projects = listed.length > 1 ? listed : projectsFromFolders(dirname(dirname(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))));
  const found = routingWarning({
    root,
    changed: changedFiles(root),
    edits: input.transcript_path ? editsOutside(tailLines(input.transcript_path) ?? [], root) : [],
    projects,
    worktreeRoots: [join(homedir(), "worktrees")],
    now,
  });
  if (!found) return;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(statePath, JSON.stringify({ warnedAt: now, project: found.target.id }));
  emit({
    hookEventName: "Stop",
    additionalContext:
      `Chat routing: this work is in ${found.target.name}. This chat's repo is ${found.home.name}, and ${found.why}. ` +
      `Carry it on in a chat in ${found.target.name}. This is a warning: nothing is blocked.`,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) advisory(main);
