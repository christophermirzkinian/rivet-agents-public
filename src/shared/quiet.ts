export interface QuietSettings {
  enabled: boolean;
  /** "HH:MM", wall time in Rivet's time zone. */
  start: string;
  end: string;
}

export interface PushSettingsResponse extends QuietSettings {
  held: number;
  quietNow: boolean;
}

export const DEFAULT_QUIET: QuietSettings = {
  enabled: true,
  start: "22:00",
  end: "07:00",
};

export function parseHhMm(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
