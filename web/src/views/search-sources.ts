import type { SearchItem } from "../../../src/shared/search.js";

// The header search's sources, apart from search.ts so a view that adds one (chat.ts) never waits on search.ts's own
// imports, which come back round to it.

export type SearchSource = (query: string) => SearchItem[] | Promise<SearchItem[]>;

export const searchSources = new Map<string, SearchSource>();

export function registerSearchSource(name: string, source: SearchSource): void {
  searchSources.set(name, source);
}
