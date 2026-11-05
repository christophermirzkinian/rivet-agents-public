const DAY = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });

/** The calendar day of `at` in the phone's own time zone, as YYYY-MM-DD; "" for a time that is not one. */
export function localDay(at: string | number | Date): string {
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? DAY.format(t) : "";
}
