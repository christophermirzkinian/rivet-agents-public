// Which project a new chat belongs to, from its ask. Nothing here falls back to a default repo: an ask that
// matches nothing, or two projects alike, is asked about, or goes to General when nobody is watching.
import os from "node:os";
import path from "node:path";

import { COMMON, GENERAL_ID } from "./projects.mjs";

/**
 * @typedef {import("./projects.mjs").Project} Project
 * @typedef {import("./projects.mjs").Product} Product
 * @typedef {{ project: string, sure: boolean, why: string, step?: string, hits?: number }} Routed a sure answer's step and its count of distinct terms
 * @typedef {{ ask: true, choices: string[], why: string, newProject?: { name: string } }} AskUser
 * @typedef {Map<string, Set<string>>} Hits project id -> what matched it
 */

const NEW = "new";
const NOUNS = "app|app|site|website|web ?site|page|tool|bot|shop|store|dashboard|service|api|extension|plugin|add-?on|script";
const NEW_RE = new RegExp(`\\b(?:build|make|start|create|set up|spin up)\\b(.*?)\\b(${NOUNS})s?\\b`, "i");
const FILLER = new Set(["me", "us", "a", "an", "the", "my", "our", "new", "brand", "some", "simple", "little", "small", "quick", "basic", "for", "of", "to"]);

const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A term as a whole-word, case-blind pattern; a dash, underscore or space in it matches any of them or none. @param {string} term */
const termRe = (term) => new RegExp(`(?<![a-z0-9])${term.trim().split(/[-_\s]+/).map(escape).join("[-_\\s]?")}(?![a-z0-9])`, "gi");

/** @param {string} p */
const expand = (p) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

/** @param {string} child @param {string} parent */
const within = (child, parent) => child === parent || child.startsWith(`${parent.replace(/\/+$/, "")}/`);

/**
 * Where the text holds each of `terms`, with a match inside a longer match dropped ("Acme" inside "Acme Shop").
 * @param {string} text @param {{ id: string, term: string }[]} terms
 */
function findTerms(text, terms) {
  /** @type {{ id: string, term: string, start: number, end: number }[]} */
  const found = [];
  for (const { id, term } of terms) {
    if (!/[a-z0-9]/i.test(term)) continue;
    for (const m of text.matchAll(termRe(term))) found.push({ id, term: m[0], start: m.index, end: m.index + m[0].length });
  }
  return found.filter((f) => !found.some((g) => g !== f && g.start <= f.start && g.end >= f.end && g.end - g.start > f.end - f.start));
}

/** @param {{ id: string, term: string }[]} found */
function toHits(found) {
  /** @type {Hits} */
  const hits = new Map();
  for (const f of found) hit(hits, f.id, f.term.toLowerCase());
  return hits;
}

/** The terms of `terms` the text holds. @param {string} text @param {{ id: string, term: string }[]} terms */
const matchTerms = (text, terms) => toHits(findTerms(text, terms));

/** A project's own name, id and repo names. @param {Project} p @param {Project[]} projects */
const nameTerms = (p, projects) =>
  [p.id, p.name, ...repoNames(p, projects)].filter((term) => typeof term === "string").map((term) => ({ id: p.id, term: /** @type {string} */ (term) }));

/** The project inside `home`'s repo that owns a repo-relative path, else `home`. @param {Project} home @param {string} rel @param {Project[]} projects */
const innerOf = (home, rel, projects) =>
  projects.find((x) => x.workspaceRepo === home.workspaceRepo && x.id !== home.id && x.paths.some((dir) => within(rel, dir.replace(/\/+$/, "")))) ?? home;

/** @param {Hits} hits @param {string} id @param {string} what */
function hit(hits, id, what) {
  if (!hits.has(id)) hits.set(id, new Set());
  hits.get(id)?.add(what);
}

/**
 * The project ids with the most hits, best first, in list order on a tie.
 * @param {Hits} hits @param {Project[]} projects
 */
function ranked(hits, projects) {
  const order = projects.map((p) => p.id);
  return [...hits.keys()].sort((a, b) => (hits.get(b)?.size ?? 0) - (hits.get(a)?.size ?? 0) || order.indexOf(a) - order.indexOf(b));
}

/**
 * The repo names a project answers to: its own and GitHub repo, unless it only lives inside another project's repo.
 * @param {Project} p @param {Project[]} projects
 */
const repoNames = (p, projects) =>
  !p.folder && projects.some((o) => o !== p && o.folder && o.workspaceRepo === p.workspaceRepo) ? [] : [p.workspaceRepo, p.githubRepo, p.githubRepo?.split("/")[1]];

/** The project a name names: its id or name, else a repo name it answers to. @param {Project[]} projects @param {string} name */
function named(projects, name) {
  const want = name.trim().replace(/\.git$/i, "").toLowerCase();
  const is = (/** @type {unknown} */ v) => typeof v === "string" && v.toLowerCase() === want;
  return projects.find((p) => is(p.id) || is(p.name)) ?? projects.find((p) => repoNames(p, projects).some(is));
}

/** Step 1: a repo or project named outright: the `repo` given, `name:X`, `in X`, or a GitHub link. */
function explicit(/** @type {string} */ ask, /** @type {string | null} */ repo, /** @type {Project[]} */ projects) {
  /** @type {Hits} */
  const hits = new Map();
  if (repo) {
    const p = named(projects, repo);
    if (p) hit(hits, p.id, repo);
  }
  for (const m of ask.matchAll(/\bname:([\w.-]+)/gi)) {
    const p = named(projects, m[1].replace(/\.+$/, ""));
    if (p) hit(hits, p.id, m[0]);
  }
  // A link to a file or folder names the project holding that path inside the repo (rivet/ inside the company repo).
  // Punctuation after a link (a comma, quote, bracket or full stop) is not part of it.
  for (const m of ask.matchAll(/github\.com\/([\w-]+\/[\w.-]+)(?:\/(?:blob|tree)\/[^/\s]+\/([^\s?#<>()[\]{}"'`,;!]+))?/gi)) {
    const p = named(projects, m[1].replace(/\.+$/, "").replace(/\.git$/i, ""));
    const sub = m[2]?.replace(/[.:]+$/, "");
    if (p) hit(hits, (sub ? innerOf(p, sub, projects) : p).id, m[0]);
  }
  // "in X": the longest project name that starts right after "in", so "in Rivet Third" is never "in Rivet".
  const terms = projects.filter((p) => p.id !== GENERAL_ID).flatMap((p) => nameTerms(p, projects));
  for (const f of findTerms(ask, terms)) if (/\bin\s+$/i.test(ask.slice(0, f.start))) hit(hits, f.id, `in ${f.term}`);
  return hits;
}

/** The path-like words of an ask: anything with a slash that is not a web link. @param {string} ask */
const askPaths = (ask) => ask.replace(/\b\w+:\/\/\S+/g, " ").match(/(?:~|\.{1,2})?\/?[\w@.-]+(?:\/[\w@.-]*)+/g) ?? [];

/**
 * Step 2: the project holding each named path: an absolute path under a project's folder (then a project that owns
 * the sub-folder inside the same repo), or a repo-relative path under a project's `paths` or a product's folder.
 * A path under a worktree root (`<root>/<repo>/<worktree>/...`, where chats run) goes to that repo's project.
 * @param {string[]} paths @param {Project[]} projects @param {Product[]} products @param {string[]} worktreeRoots
 */
function byPaths(paths, projects, products, worktreeRoots) {
  /** @type {Hits} */
  const hits = new Map();
  /** @param {string} rel @param {Project[]} pool */
  const owner = (rel, pool) => pool.find((p) => p.paths.some((dir) => within(rel, dir.replace(/\/+$/, ""))));
  for (const raw of paths) {
    const p = expand(raw.trim());
    if (path.isAbsolute(p)) {
      const homes = projects.filter((x) => x.folder && within(p, expand(x.folder))).sort((a, b) => expand(b.folder ?? "").length - expand(a.folder ?? "").length);
      const home = homes[0];
      if (home?.folder) {
        hit(hits, innerOf(home, path.relative(expand(home.folder), p), projects).id, raw);
        continue;
      }
      for (const root of worktreeRoots.map(expand)) {
        if (!within(p, root)) continue;
        const [repo, worktree, ...rest] = path.relative(root, p).split(path.sep);
        if (!repo || !worktree) continue;
        const main = projects.filter((x) => x.workspaceRepo === repo).sort((a, b) => Number(Boolean(b.folder)) - Number(Boolean(a.folder)))[0];
        if (main) hit(hits, innerOf(main, rest.join("/"), projects).id, raw);
        break;
      }
      continue;
    }
    const rel = p.replace(/^\.\//, "");
    const project = owner(rel, projects);
    if (project) {
      hit(hits, project.id, raw);
      continue;
    }
    const product = products.filter((x) => within(rel, x.folder)).sort((a, b) => b.folder.length - a.folder.length)[0];
    if (product) hit(hits, viaPaths(product, projects), raw);
  }
  return hits;
}

/** A product's project, unless a project owns its folder (a product that is its own project inside the repo). @param {Product} product @param {Project[]} projects */
export const viaPaths = (product, projects) => projects.find((p) => p.paths.some((dir) => within(product.folder, dir.replace(/\/+$/, ""))))?.id ?? product.project;

/**
 * Last step: product names, ids, folders and packages. A product name is often an everyday phrase that an unrelated
 * ask uses too, so a product match only suggests its project on the card, never routes by itself; a product's
 * folder still routes surely through the paths step.
 * @param {string} ask @param {Project[]} projects @param {Product[]} products
 */
function byProducts(ask, projects, products) {
  const ids = new Set(projects.map((p) => p.id));
  const terms = products.flatMap((product) => {
    const id = viaPaths(product, projects);
    if (!ids.has(id)) return [];
    const packages = product.packages.flatMap((pkg) => [pkg, pkg.replace(/^@[^/]+\//, "")]);
    return [product.id, product.name, product.folder, path.basename(product.folder), ...packages].map((term) => ({ id, term }));
  });
  return matchTerms(ask, terms);
}

/** Steps 1b and 4: a project's own name, id and repo names; with `words`, its words too. @param {string} ask @param {Project[]} projects @param {boolean} words */
function byNames(ask, projects, words) {
  const terms = projects
    .filter((p) => p.id !== GENERAL_ID)
    .flatMap((p) => [...nameTerms(p, projects).filter(({ term }) => !COMMON.has(term.trim().toLowerCase())), ...(words ? p.words.map((term) => ({ id: p.id, term })) : [])]);
  return matchTerms(ask, terms);
}

/** A 1-3 word name for something new the ask builds, or null when it builds nothing. @param {string} ask */
export function newProjectName(ask) {
  const m = NEW_RE.exec(ask);
  if (!m) return null;
  const noun = m[2].toLowerCase().replace(/^web ?site$/, "website");
  const first = m[1].split(/\s+/).map((w) => w.replace(/[^\w-]/g, "")).find((w) => w && !FILLER.has(w.toLowerCase()));
  const name = first ? `${first.toLowerCase()} ${noun}` : `new ${noun}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** @param {Hits} hits @param {string[]} ids @param {Project[]} projects */
function said(hits, ids, projects) {
  return ids
    .map((id) => `${[...(hits.get(id) ?? [])].map((t) => `"${t}"`).join(", ")}: the ${projects.find((p) => p.id === id)?.name ?? id} project`)
    .join("; ");
}

/**
 * The project a chat belongs to. In order: a repo or project the ask names outright; the paths it names; a project's
 * name; a project's words. A product of a repo's registry, matched by name alone, is suggested on a card. An ask to
 * build something new that matches nothing offers a new project; anything else unmatched, or a tie, is asked about
 * with the top two, New and General. Unattended, every question is General instead.
 * @param {{ ask: string, paths?: string[], repo?: string | null, unattended?: boolean }} chat
 * @param {{ projects: Project[], products?: Product[], worktreeRoots?: string[] }} lists
 * @returns {Routed | AskUser}
 */
export function routeChat({ ask, paths = [], repo = null, unattended = false }, { projects, products = [], worktreeRoots = [] }) {
  const text = String(ask ?? "");
  /** @type {[string, Hits][]} */
  const steps = [
    ["named", explicit(text, repo, projects)],
    ["path", byPaths([...paths, ...askPaths(text)], projects, products, worktreeRoots)],
    ["name", byNames(text, projects, false)],
    ["words", byNames(text, projects, true)],
  ];
  /** @param {AskUser} question @returns {Routed | AskUser} */
  const asked = (question) => (unattended ? { project: GENERAL_ID, sure: false, why: `${question.why}; nobody is watching, so General` } : question);
  for (const [step, hits] of steps) {
    if (!hits.size) continue;
    const top = ranked(hits, projects);
    const best = hits.get(top[0])?.size ?? 0;
    const tied = top.filter((id) => (hits.get(id)?.size ?? 0) === best);
    if (tied.length === 1) return { project: top[0], sure: true, why: `Matched ${said(hits, [top[0]], projects)} (${step})`, step, hits: best };
    const two = tied.slice(0, 2);
    return asked({ ask: true, choices: [...two, NEW, GENERAL_ID], why: `Matched two projects alike: ${said(hits, two, projects)}` });
  }
  const byProduct = byProducts(text, projects, products);
  if (byProduct.size) {
    const two = ranked(byProduct, projects).slice(0, 2);
    return asked({ ask: true, choices: [...two, NEW, GENERAL_ID], why: `Matched only a product name, which can be an everyday phrase: ${said(byProduct, two, projects)}` });
  }
  const name = newProjectName(text);
  if (name) return asked({ ask: true, newProject: { name }, choices: [NEW, GENERAL_ID], why: `Matched no project, and the ask builds something new: "${name}"` });
  return asked({ ask: true, choices: [NEW, GENERAL_ID], why: "Matched no project" });
}
