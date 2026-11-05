// The header search's items and ranking, shared by the web app's sources and the
// server's history endpoint. No zod, so the web app can import it.

export type SearchKind =
  | "card"
  | "coming"
  | "shipped"
  | "waiting"
  | "reply"
  | "worker"
  | "pr"
  | "app"
  | "timeline"
  | "briefing"
  | "chat"
  | "message";

export type SearchTarget =
  | { type: "card"; id: string }
  | { type: "tab"; tab: "feed" | "chat" | "ops" | "agents"; section?: string }
  | { type: "chat"; name: string; repo?: string }
  | { type: "url"; url: string }
  | { type: "worker"; id: string }
  | { type: "reply"; id: string }
  | { type: "briefing"; id: string }
  | { type: "message"; id: string };

export interface SearchItem {
  kind: SearchKind;
  /** Unique within the results, so a source's copy and the server's never both show. */
  key: string;
  title: string;
  detail?: string;
  at?: string | null;
  repo?: string;
  open: SearchTarget;
}

export const MIN_QUERY = 2;
export const MAX_RESULTS = 40;

/** What wins a tie between equally good matches: things waiting on you first. */
const KIND_WEIGHT: Record<SearchKind, number> = {
  card: 12,
  worker: 6,
  pr: 6,
  app: 6,
  coming: 4,
  waiting: 4,
  chat: 4,
  message: 3,
  briefing: 3,
  shipped: 3,
  timeline: 2,
  reply: 2,
};

export function normalise(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      // Stored text keeps the old name; "Rivet Ops" and "Rivet Ops" find each other.
      .replace(/\brivet\b/g, "rivet")
  );
}

function words(value: string): string[] {
  return value.split(/[^a-z0-9#]+/).filter(Boolean);
}

function termScore(term: string, title: string, titleWords: string[], rest: string, restWords: string[]): number {
  if (title === term) return 100;
  if (title.startsWith(term)) return 60;
  if (titleWords.some((word) => word === term || word === `#${term}`)) return 50;
  if (titleWords.some((word) => word.startsWith(term) || word.startsWith(`#${term}`))) return 40;
  if (title.includes(term)) return 25;
  if (restWords.some((word) => word === term || word === `#${term}` || word.startsWith(term))) return 15;
  if (rest.includes(term)) return 10;
  return 0;
}

/** 0 when any query term is missing; higher is better. */
export function scoreItem(item: SearchItem, query: string, now: number): number {
  const terms = normalise(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const title = normalise(item.title);
  const rest = normalise([item.detail ?? "", item.repo ?? "", item.kind].join(" "));
  const titleWords = words(title);
  const restWords = words(rest);
  let score = 0;
  for (const term of terms) {
    const one = termScore(term, title, titleWords, rest, restWords);
    if (one === 0) return 0;
    score += one;
  }
  if (terms.length > 1 && title.includes(terms.join(" "))) score += 30;
  score += KIND_WEIGHT[item.kind];
  const at = item.at ? Date.parse(item.at) : NaN;
  if (Number.isFinite(at)) {
    const age = now - at;
    if (age < 24 * 3600_000) score += 3;
    else if (age < 7 * 24 * 3600_000) score += 1;
  }
  return score;
}

/** The best matches, one per key (the first source to offer a key wins), best first. */
export function rankSearch(items: readonly SearchItem[], query: string, now: number, limit = MAX_RESULTS): SearchItem[] {
  if (normalise(query).trim().length < MIN_QUERY) return [];
  const seen = new Set<string>();
  const scored: { item: SearchItem; score: number }[] = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    const score = scoreItem(item, query, now);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.item.at ?? "").localeCompare(a.item.at ?? "") ||
      a.item.title.localeCompare(b.item.title),
  );
  return scored.slice(0, limit).map((entry) => entry.item);
}
