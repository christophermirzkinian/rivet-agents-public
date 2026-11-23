// Each service's logo for Connectors: simple-icons 16.38.0 (CC0-1.0) SVGs in public/logos, drawn white on the brand's
// own colour, as public/LICENSES.yaml records. Each mark stays its owner's trademark and only names its service. A
// service simple-icons has no logo for gets the server's monogram on a plain tile. The colour and the mark are
// connectors.css's, keyed on the tile's data-logo: the CSP (style-src 'self') refuses a style attribute.

import type { ConnectorService } from "../../src/shared/connectors.js";

export interface Logo {
  /** The file in public/logos and the tile's data-logo, or null for a monogram. */
  slug: string | null;
  mono: string;
}

const mark = (slug: string, mono: string): Logo => ({ slug, mono });
const plain = (mono: string): Logo => ({ slug: null, mono });

const LOGOS: Record<string, Logo> = {
  claude: mark("claude", "C"),
  "anthropic-api": mark("claude", "A"),
  gemini: mark("googlegemini", "G"),
  github: mark("github", "GH"),
  fly: mark("flydotio", "F"),
  "home-assistant": mark("homeassistant", "HA"),
  youtube: mark("youtube", "YT"),
  instagram: mark("instagram", "IG"),
  "google-play": mark("googleplay", "GP"),
  "app-store": mark("appstore", "AS"),
  reddit: mark("reddit", "R"),
  tiktok: mark("tiktok", "TT"),
  meta: mark("meta", "M"),
};

/** A service's logo; one this list does not know gets its monogram, or its name's first two letters. */
export function logoOf({ id, name, mono }: Pick<ConnectorService, "id" | "name" | "mono">): Logo {
  return LOGOS[id] ?? plain(mono ?? name.slice(0, 2).toUpperCase());
}
