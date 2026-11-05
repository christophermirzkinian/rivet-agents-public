import { clipUnits, sanitizeLine } from "../templates.mjs";

/**
 * One line of plain text, at most `max` UTF-16 units (the server's zod limit),
 * never splitting a character.
 * @param {unknown} value
 * @param {number} max
 */
export function clip(value, max) {
  return clipUnits(sanitizeLine(typeof value === "string" ? value : "", max), max);
}

const MAX_ISO_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** An ISO instant in the server's format, or null. @param {unknown} value */
export function iso(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const t = typeof value === "number" ? value : Date.parse(value);
  // Past year 9999 toISOString() gives a six-digit year the server rejects, and past
  // 8.64e15 ms it throws.
  return Number.isFinite(t) && t > 0 && t <= MAX_ISO_MS ? new Date(t).toISOString() : null;
}

/** @param {unknown} value */
export function count(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, 100_000) : 0;
}

/** Parses JSON output from a CLI, or throws a short error naming the tool. @param {string} stdout @param {string} tool */
export function parseJson(stdout, tool) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${tool} returned non-JSON`);
  }
}
