/** Past this many characters in all of a file's tokens together, Markdown is shown as plain text. */
export const MD_MAX_TOKEN_CHARS = 4_000_000;

/** Whether every string in the tokens, nested ones included, adds up to no more than `limit` characters. */
export function tokensWithin(tokens: unknown, limit: number): boolean {
  let left = limit;
  const stack: unknown[] = [tokens];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string") {
      left -= value.length;
      if (left < 0) return false;
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) stack.push(child);
    }
  }
  return true;
}
