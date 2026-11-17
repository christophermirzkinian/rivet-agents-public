// An installed app a phone kept suspended can wake on the build it loaded days ago. Back on screen after AWAY_MS
// hidden, it reads the app shell again and reloads when the shell names another main script, unless anything typed
// is still unsent (a reload would lose text that lives only in the page).

export const AWAY_MS = 5 * 60_000;

/** The src of the shell's module script: the build's hashed entry. */
export function mainScript(html: string): string | null {
  for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
    if (!/\btype="module"/.test(tag)) continue;
    const src = /\bsrc="([^"]+)"/.exec(tag)?.[1];
    if (src) return src;
  }
  return null;
}

/** Any text field or editable area holding more than whitespace. */
export function hasUnsent(doc: Pick<Document, "querySelectorAll">): boolean {
  for (const field of doc.querySelectorAll<HTMLElement>("textarea, input:not([type]), input[type='text'], input[type='search'], [contenteditable='true'], [contenteditable='']")) {
    const text = "value" in field ? String(field.value) : field.textContent;
    if ((text ?? "").trim()) return true;
  }
  return false;
}

type Watch = {
  doc?: Document;
  fetch?: typeof fetch;
  reload?: () => void;
  now?: () => number;
};

export function watchNewBuild({ doc = document, fetch = globalThis.fetch.bind(globalThis), reload = () => location.reload(), now = Date.now }: Watch = {}): () => Promise<void> {
  const loaded = doc.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null;
  let hiddenAt: number | null = null;
  const check = async (): Promise<void> => {
    if (doc.visibilityState === "hidden") {
      hiddenAt ??= now();
      return;
    }
    const away = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    if (away < AWAY_MS || !loaded) return;
    try {
      const response = await fetch("/", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return;
      const latest = mainScript(await response.text());
      if (latest && latest !== loaded && !hasUnsent(doc)) reload();
    } catch {
      // Offline: the next return tries again.
    }
  };
  doc.addEventListener("visibilitychange", () => void check());
  return check;
}
