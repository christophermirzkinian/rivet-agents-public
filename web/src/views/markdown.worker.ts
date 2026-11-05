// Lexes Markdown off the page's thread, so a file that makes marked slow (it has inputs that take time quadratic in
// their length) can be given up on without freezing the app. The tokens go back as plain data, or null when they would
// lay out far more text than the file holds: a reference link is copied into every use of it.
import { lexer } from "marked";

import { tokensWithin, MD_MAX_TOKEN_CHARS } from "./markdown-size.js";

const scope = self as unknown as { onmessage: ((event: MessageEvent<string>) => void) | null; postMessage(value: unknown): void };
scope.onmessage = (event) => {
  const tokens = lexer(event.data);
  scope.postMessage(tokensWithin(tokens, MD_MAX_TOKEN_CHARS) ? tokens : null);
};
