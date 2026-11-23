// The projects a chat can belong to. The owner's list is a JSON file kept out of the public export; Cloud and Public
// build theirs from the folders under a projects root. route-chat.mjs picks a chat's project from it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ id: string, name: string, workspaceRepo: string, githubRepo: string | null, folder: string | null, words: string[], paths: string[], appOnly: boolean }} Project
 * @typedef {{ id: string, name: string, folder: string, packages: string[], project: string }} Product
 */

export const DEFAULT_PROJECTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "project-list.json");
export const GENERAL_ID = "general";

/** @type {Readonly<Project>} */
export const GENERAL = Object.freeze({ id: GENERAL_ID, name: "General", workspaceRepo: "General", githubRepo: null, folder: null, words: [], paths: [], appOnly: false });

const KEYS = ["id", "name", "workspaceRepo", "githubRepo", "folder", "words", "paths", "appOnly"];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const GITHUB_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** @param {unknown} list @param {(s: string) => boolean} [ok] */
const strings = (list, ok = (s) => s.trim() !== "") => Array.isArray(list) && list.every((s) => typeof s === "string" && ok(s));

/**
 * One entry of a projects file, checked; throws naming the entry and the field.
 * @param {any} entry @param {number} i @param {string} file
 * @returns {Project}
 */
function checkEntry(entry, i, file) {
  const bad = (/** @type {string} */ what) => new Error(`${file}: project ${i + 1}${typeof entry?.id === "string" ? ` (${entry.id})` : ""}: ${what}`);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw bad("is not an object");
  const extra = Object.keys(entry).filter((key) => !KEYS.includes(key));
  if (extra.length) throw bad(`unknown field ${extra.join(", ")}`);
  if (typeof entry.id !== "string" || !ID_RE.test(entry.id)) throw bad("id must be lowercase letters, digits and dashes");
  if (typeof entry.name !== "string" || !entry.name.trim()) throw bad("name must be a non-empty string");
  if (typeof entry.workspaceRepo !== "string" || !entry.workspaceRepo.trim()) throw bad("workspaceRepo must be a non-empty string");
  if (entry.githubRepo !== null && (typeof entry.githubRepo !== "string" || !GITHUB_RE.test(entry.githubRepo))) throw bad("githubRepo must be owner/name or null");
  if (entry.folder !== null && (typeof entry.folder !== "string" || !entry.folder.trim())) throw bad("folder must be a path or null");
  if (!strings(entry.words, (s) => /[a-z0-9]/i.test(s))) throw bad("words must be a list of strings that each hold a letter or digit");
  if (!strings(entry.paths, (p) => /^[^/~].*\/$/.test(p))) throw bad("paths must be repo-relative folders ending in /");
  if (typeof entry.appOnly !== "boolean") throw bad("appOnly must be true or false");
  return { id: entry.id, name: entry.name, workspaceRepo: entry.workspaceRepo, githubRepo: entry.githubRepo, folder: entry.folder, words: [...entry.words], paths: [...entry.paths], appOnly: entry.appOnly };
}

/**
 * The project list: the file RIVET_PROJECTS_FILE names, else config/project-list.json. A missing file is the General
 * project alone; a file that does not parse, or holds a bad entry, throws rather than route chats by a guess.
 * @param {{ file?: string }} [opts]
 * @returns {Project[]}
 */
export function loadProjects({ file = process.env.RIVET_PROJECTS_FILE || DEFAULT_PROJECTS_FILE } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return [{ ...GENERAL }];
    throw err;
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${/** @type {Error} */ (err).message})`);
  }
  if (!Array.isArray(list)) throw new Error(`${file}: must be a list of projects`);
  const projects = list.map((entry, i) => checkEntry(entry, i, file));
  const seen = new Set();
  for (const project of projects) {
    if (seen.has(project.id)) throw new Error(`${file}: project id ${project.id} is listed twice`);
    seen.add(project.id);
  }
  if (!seen.has(GENERAL_ID)) projects.push({ ...GENERAL });
  return projects;
}

/**
 * Words too common to route by alone: a folder name's pieces ("my-app" must not take every ask saying "my" or "app"),
 * and a folder whose whole name is one of them ("website") routes only when named outright ("in website").
 */
export const COMMON = new Set(
  ("the and for our you new old my app apps site sites website web page project projects test tests demo copy main dev src code repo " +
    "tool tools api bot service thing stuff work files backup temp tmp final draft v2 v3 app apps shop store dashboard extension " +
    "plugin script scripts blog notes note docs data client server list lists home helper manager tracker family personal photos")
    .split(" "),
);

/** A folder name as a project id. @param {string} name */
export const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * One project per sub-folder of a projects root (Cloud's /srv/projects, Public's projects root), plus General
 * when the root has no general folder. A missing root is General alone.
 * @param {string} root
 * @returns {Project[]}
 */
export function projectsFromFolders(root) {
  /** @type {fs.Dirent[]} */
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
  }
  /** @type {Project[]} */
  const projects = [];
  const seen = new Set();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const id = slug(entry.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const words = id === GENERAL_ID ? [] : entry.name.split(/[-_\s]+/).filter((w) => w.length > 2 && /[a-z]/i.test(w) && !COMMON.has(w.toLowerCase()));
    projects.push({ id, name: entry.name, workspaceRepo: entry.name, githubRepo: null, folder: path.join(root, entry.name), words, paths: [], appOnly: false });
  }
  if (!seen.has(GENERAL_ID)) projects.push({ ...GENERAL, folder: path.join(root, GENERAL_ID) });
  return projects;
}

/**
 * The products of a repo's root project registry, each routed to one project (the repo that holds them).
 * @param {string | any[]} registryJson the registry's text or its parsed list
 * @param {string} [project]
 * @returns {Product[]}
 */
export function productsFromRegistry(registryJson, project = "rivet") {
  const list = typeof registryJson === "string" ? JSON.parse(registryJson) : registryJson;
  if (!Array.isArray(list)) throw new Error("the projects registry must be a list");
  return list.map((entry, i) => {
    if (typeof entry?.id !== "string" || typeof entry.name !== "string" || typeof entry.folder !== "string") throw new Error(`projects registry entry ${i + 1}: needs id, name and folder`);
    const packages = Array.isArray(entry.packages) ? entry.packages.filter((/** @type {unknown} */ p) => typeof p === "string") : [];
    return { id: entry.id, name: entry.name, folder: entry.folder.replace(/\/+$/, ""), packages, project };
  });
}
