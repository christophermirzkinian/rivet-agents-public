// A new project's name: 1-3 plain words, never one an existing project or folder already has.
import fs from "node:fs";
import path from "node:path";

import { GENERAL_ID, slug } from "./projects.mjs";
import { newProjectName } from "./route-chat.mjs";

const FALLBACK = "New project";

/** At most 3 words of letters, digits and dashes, first letter capital; null when nothing is left. @param {unknown} raw */
export function cleanName(raw) {
  const words = String(raw ?? "")
    .replace(/[^A-Za-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .slice(0, 3);
  if (!words.length) return null;
  const name = words.join(" ").slice(0, 40).trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A name's folder: its words joined by dashes, lowercase on Cloud. @param {string} name @param {{ lowercase?: boolean }} [opts] */
export const projectFolder = (name, { lowercase = false } = {}) => (lowercase ? slug(name) : name.trim().split(/\s+/).join("-"));

/** @param {string} root */
function entriesOf(root) {
  try {
    return fs.readdirSync(root);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * `raw` cleaned, with " 2", " 3" and so on added while a project's id, name or folder, or an entry of `root`, already
 * has it (by letters and digits alone, any case). `except` is an entry of `root` that does not count: the project
 * being renamed.
 * @param {unknown} raw
 * @param {{ projects?: import("./projects.mjs").Project[], root?: string, except?: string }} [opts]
 */
export function uniqueProjectName(raw, { projects = [], root, except } = {}) {
  const base = cleanName(raw) ?? FALLBACK;
  const taken = new Set([GENERAL_ID, ...projects.flatMap((p) => [p.id, p.name, p.folder ? path.basename(p.folder) : ""].map(slug))]);
  if (root) for (const entry of entriesOf(root)) if (entry !== except) taken.add(slug(entry));
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.has(slug(name))) return name;
  }
}

/**
 * The name to offer for a new project: routeChat's newProject.name when it gave one, else one read from the ask.
 * @param {{ name?: string | null, ask?: string, projects?: import("./projects.mjs").Project[], root?: string }} opts
 */
export function pickProjectName({ name, ask = "", projects = [], root }) {
  return uniqueProjectName(cleanName(name) ?? newProjectName(ask), { projects, root });
}
