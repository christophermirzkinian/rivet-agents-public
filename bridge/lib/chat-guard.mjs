// The open-time guard: a chat opened in a repo its caller chose is refused when its ask plainly belongs to
// another project and says nothing of the chosen one. `--force-project "<reason>"` opens it anyway, logged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GENERAL_ID, loadProjects, productsFromRegistry } from "./projects.mjs";
import { routeChat, viaPaths } from "./route-chat.mjs";

/**
 * @typedef {import("./projects.mjs").Project} Project
 * @typedef {import("./projects.mjs").Product} Product
 * @typedef {{ projects: Project[], products: Product[], worktreeRoots?: string[] }} Lists
 * @typedef {{ forced: string, routed: Project, why: string }} Mismatch
 */

const LIB = path.dirname(fileURLToPath(import.meta.url));
/** A folder with `~/` read from home, as route-chat reads it. @param {string} p */
const home = (p) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
// The installed Rivet's copy beside its project list (rivet/scripts/install-bridge.sh) first, as its lib's grandparent
// is $HOME; else the repo root's registry (the jobs-bin copy keeps the repo's layout above bin/, scripts/credit-jobs-runtime.sh).
/** @param {string} lib the bridge/lib folder */
export function registryFileFor(lib) {
  const files = [path.join(lib, "..", "..", "config", "registry.json"), path.join(lib, "..", "..", "..", "registry.json")];
  return files.find((file) => fs.existsSync(file)) ?? files[1];
}
export const REGISTRY_FILE = registryFileFor(LIB);

// Where the chat worktrees live (<root>/<repo>/<chat>/…), so a path in an ask routes to its repo.
export const WORKTREE_ROOT = path.join(os.homedir(), "worktrees");

/**
 * The project list, the registry's products and the worktree roots; a tree with no registry has no products.
 * @param {{ projectsFile?: string, registryFile?: string, worktreeRoots?: string[] }} [opts]
 * @returns {Lists}
 */
export function loadLists({ projectsFile, registryFile = REGISTRY_FILE, worktreeRoots = [WORKTREE_ROOT] } = {}) {
  const projects = loadProjects(projectsFile ? { file: projectsFile } : undefined);
  let text = null;
  try {
    text = fs.readFileSync(registryFile, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
  }
  return { projects, products: text === null ? [] : productsFromRegistry(text), worktreeRoots };
}

/** The project a repo or project name names, or null. @param {string} name @param {Lists} lists */
export function projectOf(name, lists) {
  const r = routeChat({ ask: "", repo: name }, lists);
  return "project" in r && r.sure ? (lists.projects.find((p) => p.id === r.project) ?? null) : null;
}

/** The worktree repo a forced name opens in: its project's, else the name's own last part. @param {string} name @param {Lists} lists */
export const workspaceRepoOf = (name, lists) => (projectOf(name, lists)?.workspaceRepo ?? name.split("/").pop() ?? name).toLowerCase();

const STEPS = ["named", "path", "name", "words"];

/**
 * How strong the evidence behind a router answer is: named > path > name > at least two words, else 0. One everyday
 * word ("hello", "notes", "paper") or a product term ("play", "banner") is 0, as is any unsure answer.
 * @param {ReturnType<typeof routeChat>} route
 */
export function strength(route) {
  if (!("project" in route) || !route.sure || !route.step) return 0;
  if (route.step === "words" && (route.hits ?? 0) < 2) return 0;
  return STEPS.length - STEPS.indexOf(route.step);
}

/** @param {ReturnType<typeof routeChat>} route */
export const strong = (route) => strength(route) > 0;

/**
 * The project an ask belongs to instead of `forced`: routed strongly to a project in another worktree repo, while no project
 * of the forced repo routes it at least as strongly. Null otherwise, and for no ask.
 * @param {{ ask: string | null | undefined, forced: string | null | undefined }} chat @param {Lists} lists
 * @returns {Mismatch | null}
 */
export function mismatch({ ask, forced }, lists) {
  if (!ask || !forced) return null;
  const routed = routeChat({ ask }, lists);
  const level = strength(routed);
  if (!level || !("project" in routed)) return null;
  const other = lists.projects.find((p) => p.id === routed.project);
  const repo = workspaceRepoOf(forced, lists);
  if (!other || other.workspaceRepo.toLowerCase() === repo) return null;
  // General is every unplaced ask's choice, so it scores nothing for itself. Each project is routed alone, so two of
  // the forced repo's own projects never tie each other away. A product's path answers with its own project even when
  // that project is not in the list, so p is routed with only its own products, and only an answer naming p counts.
  const pool = lists.projects.filter((p) => p.workspaceRepo.toLowerCase() === repo && p.id !== GENERAL_ID);
  // A project inside p's folder, or inside one of p's repo's chat worktrees, stays beside it, so a path in that inner
  // folder still answers with the inner project.
  const backs = (/** @type {Project} */ p) => {
    const products = lists.products.filter((x) => viaPaths(x, lists.projects) === p.id);
    const outers = [...(p.folder ? [home(p.folder)] : []), ...(lists.worktreeRoots ?? []).map((root) => path.join(home(root), p.workspaceRepo))];
    const inside = (/** @type {string} */ folder) => outers.some((outer) => home(folder).startsWith(`${outer.replace(/\/+$/, "")}/`));
    const inner = lists.projects.filter((x) => x !== p && x.folder && inside(x.folder));
    const alone = routeChat({ ask }, { ...lists, projects: [p, ...inner], products });
    return "project" in alone && alone.project === p.id && strength(alone) >= level;
  };
  if (pool.some(backs)) return null;
  return { forced, routed: other, why: routed.why };
}

/** @param {Mismatch} m */
export const refusal = (m) => `This ask matches ${m.routed.name} (${m.why}), not ${m.forced}. Use --force-project "<reason>" to open it there anyway.`;

/** @param {string} home */
export const forcedLog = (home) => path.join(home, ".rivet", "chat-routing", "forced.jsonl");

/**
 * One line of the forced-open log.
 * @param {{ home: string, chat: string, forced: string, routed: string, reason: string, now?: number }} entry
 */
export function logForced({ home, chat, forced, routed, reason, now = Date.now() }) {
  const file = forcedLog(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify({ time: new Date(now).toISOString(), chat, forced, routed, reason })}\n`, { mode: 0o600 });
}
