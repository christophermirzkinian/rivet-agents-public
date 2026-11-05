import { MAX_LOG_LINES, type LogsResponse } from "../shared/command.js";

/** A worker sheet renews its lease while open; the bridge stops reading once it lapses. */
export const LOG_LEASE_MS = 60_000;

interface Lease {
  repo: string;
  chat: string;
  until: number;
  lines: string[];
  /** When each line arrived, null for lines already on the screen when the lease began. */
  times: (string | null)[];
  updatedAt: string | null;
}

/**
 * The live log leases and the lines the bridge uploaded for them. Memory only:
 * terminal output is never written to disk and never pushed, and a lapsed
 * lease drops its lines.
 */
export class LogLeases {
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(repo: string, chat: string): string {
    return `${repo}\n${chat}`;
  }

  private live(repo: string, chat: string): Lease | null {
    const key = this.key(repo, chat);
    const lease = this.leases.get(key);
    if (!lease) return null;
    if (lease.until <= this.now()) {
      this.leases.delete(key);
      return null;
    }
    return lease;
  }

  /** Starts or renews a lease; returns when it ends. */
  renew(repo: string, chat: string): number {
    const until = this.now() + LOG_LEASE_MS;
    const lease = this.live(repo, chat);
    if (lease) lease.until = until;
    else this.leases.set(this.key(repo, chat), { repo, chat, until, lines: [], times: [], updatedAt: null });
    return until;
  }

  release(repo: string, chat: string): void {
    this.leases.delete(this.key(repo, chat));
  }

  /** The bridge's upload; false when no sheet holds the lease any more. */
  append(repo: string, chat: string, lines: string[], reset: boolean): { active: boolean; until?: number } {
    const lease = this.live(repo, chat);
    if (!lease) return { active: false };
    const at = new Date(this.now()).toISOString();
    // A fresh read keeps the times of lines the lease already had; the first read of a lease is what was on the
    // screen already, so its lines have no time. A line the screen shows more than once keeps each copy's time, in
    // order, and the newest copies' when fewer are left: the oldest scrolled off.
    const known = new Map<string, (string | null)[]>();
    if (reset) lease.lines.forEach((line, i) => known.set(line, [...(known.get(line) ?? []), lease.times[i] ?? null]));
    const copies = new Map<string, number>();
    for (const line of lines) copies.set(line, (copies.get(line) ?? 0) + 1);
    for (const [line, times] of known) times.splice(0, Math.max(0, times.length - (copies.get(line) ?? 0)));
    const fresh = lines.map((line) => (known.get(line)?.length ? (known.get(line)!.shift() ?? null) : lease.updatedAt === null ? null : at));
    lease.lines = (reset ? lines : [...lease.lines, ...lines]).slice(-MAX_LOG_LINES);
    lease.times = (reset ? fresh : [...lease.times, ...fresh]).slice(-MAX_LOG_LINES);
    lease.updatedAt = at;
    return { active: true, until: lease.until };
  }

  read(repo: string, chat: string): LogsResponse {
    const lease = this.live(repo, chat);
    return {
      repo,
      chat,
      lines: lease ? [...lease.lines] : [],
      times: lease ? [...lease.times] : [],
      updatedAt: lease?.updatedAt ?? null,
      leaseUntil: lease ? new Date(lease.until).toISOString() : null,
    };
  }

  /** Live leases, for replaying `logs.subscribe` to a bridge that reconnected. */
  active(): { repo: string; chat: string; until: number }[] {
    this.sweep();
    return [...this.leases.values()].map(({ repo, chat, until }) => ({ repo, chat, until }));
  }

  sweep(): void {
    const now = this.now();
    for (const [key, lease] of this.leases) if (lease.until <= now) this.leases.delete(key);
  }
}
