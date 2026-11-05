import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";

/**
 * Request bodies held in memory before Rivet knows its caller: the
 * enrolment routes read their bodies before any session exists. A byte budget per server and per client
 * address, charged per chunk before the chunk is kept, and held until the
 * request's handler has ended and its response is closed. readJson charges
 * it; the media uploads stream to disk and do not. The server keeps its long
 * request timeout for those uploads, so readJson has its own deadline.
 */

/** Which bound a body would cross: the whole server's or its client address's share. */
export type BodyBudgetBound = "server" | "ip";

export interface BodyBudgetLimits {
  /** Body bytes held at once across the process. */
  maxBytes: number;
  /** Body bytes held at once by one client address. */
  maxBytesPerIp: number;
}

// The largest JSON body is 3 MiB (Rivet's mind, sent alone every few minutes), the rest 1 MiB or less (the bridge's
// board and where snapshots; logs are 256 KiB), parsed JSON takes ~25x its bytes, and the machine has 1 GB: 8 MiB held
// is ~200 MB parsed at worst. Rivet is one owner, whose phone or Mac may hold four 1 MiB bodies at once from one
// address, or the mind graph and one more.
export const BODY_BUDGET: BodyBudgetLimits = { maxBytes: 8 * 1024 * 1024, maxBytesPerIp: 4 * 1024 * 1024 };

/** Seconds a refused client is told to wait. */
export const BODY_BUDGET_RETRY_AFTER_SECONDS = 1;

/** The status, Retry-After and message for a body the budget refused. */
export function bodyBudgetRefusal(bound: BodyBudgetBound): { status: 429 | 503; retryAfterSeconds: number; message: string } {
  return bound === "ip"
    ? { status: 429, retryAfterSeconds: BODY_BUDGET_RETRY_AFTER_SECONDS, message: "Too many requests. Please try again later." }
    : { status: 503, retryAfterSeconds: BODY_BUDGET_RETRY_AFTER_SECONDS, message: "The server is busy; retry shortly." };
}

interface BodyHold {
  take(bytes: number): BodyBudgetBound | undefined;
  release(): void;
}

const holds = new WeakMap<IncomingMessage, BodyHold>();

/**
 * What each kept chunk costs beyond its bytes: Node gives every body chunk its
 * own Buffer (about 330 bytes of memory for a 1-byte chunk on Node 24), so a
 * body sent as many tiny chunks would hold far more than its bytes.
 */
export const BODY_CHUNK_OVERHEAD_BYTES = 1024;

/**
 * Charges `bytes` of `req`'s body, plus one chunk's overhead, to its server's
 * budget before the caller keeps them, or names the bound they would cross
 * and charges nothing. A request whose server has no budget (a test calling a
 * reader directly) is not bounded here.
 */
export function takeBody(req: IncomingMessage, bytes: number): BodyBudgetBound | undefined {
  return holds.get(req)?.take(bytes + BODY_CHUNK_OVERHEAD_BYTES);
}

class BodyBudget {
  private held = 0;
  private readonly heldByIp = new Map<string, number>();

  constructor(private readonly limits: BodyBudgetLimits) {}

  hold(ip: string): BodyHold {
    let held = 0;
    let open = true;
    return {
      take: (bytes) => {
        const ipHeld = this.heldByIp.get(ip) ?? 0;
        if (!open || this.held + bytes > this.limits.maxBytes) return "server";
        if (ipHeld + bytes > this.limits.maxBytesPerIp) return "ip";
        held += bytes;
        this.held += bytes;
        this.heldByIp.set(ip, ipHeld + bytes);
        return undefined;
      },
      release: () => {
        if (!open) return;
        open = false;
        if (held === 0) return;
        this.held -= held;
        const left = (this.heldByIp.get(ip) ?? 0) - held;
        if (left > 0) this.heldByIp.set(ip, left);
        else this.heldByIp.delete(ip);
      },
    };
  }
}

/**
 * `handler` with every request's body charged to one budget. A request holds
 * what it took until both its handler has settled and its response has closed,
 * so neither a client that leaves early nor a handler that answers before it
 * finishes lets its bytes go while they may still be in memory.
 */
export function withBodyBudget<Req extends IncomingMessage, Res extends ServerResponse>(
  handler: (req: Req, res: Res) => unknown,
  limits: BodyBudgetLimits = BODY_BUDGET,
): (req: Req, res: Res) => void {
  const budget = new BodyBudget(limits);
  return (req, res) => {
    const hold = budget.hold(bodyClientIp(req));
    holds.set(req, hold);
    let pending = 2;
    const done = () => {
      if (--pending === 0) hold.release();
    };
    if (res.closed) done();
    else res.once("close", done);
    let result: unknown;
    try {
      result = handler(req, res);
    } catch (error) {
      done();
      throw error;
    }
    void Promise.resolve(result).then(done, done);
  };
}

/**
 * Peers whose `fly-client-ip` is believed: Fly's proxy reaches a machine over
 * its private IPv4 link (172.16.0.0/12) and
 * overwrites any `fly-client-ip` a client sends. Off Fly the header is only
 * the client's claim, so it is read only when FLY_APP_NAME is set.
 */
const flyProxyPeers = new BlockList();
flyProxyPeers.addSubnet("172.16.0.0", 12, "ipv4");

const sixPn = new BlockList();
sixPn.addSubnet("fdaa::", 16, "ipv6");

/**
 * The address a body is charged to: `fly-client-ip` from Fly's proxy when
 * running on Fly, a direct 6PN caller's machine block (a machine may rotate
 * the low 16 bits of its /112), and otherwise the socket's peer.
 */
export function bodyClientIp(req: IncomingMessage): string {
  const raw = req.socket?.remoteAddress ?? "";
  const mapped = raw.toLowerCase().startsWith("::ffff:") ? raw.slice(7) : "";
  const peer = isIP(mapped) === 4 ? mapped : raw;
  const family = isIP(peer);
  if (family === 6 && sixPn.check(peer, "ipv6")) return sixPnMachine(peer);
  if (!process.env.FLY_APP_NAME || family !== 4 || !flyProxyPeers.check(peer, "ipv4")) return peer;
  const header = req.headers["fly-client-ip"];
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  return value && isIP(value) !== 0 ? value : peer;
}

function sixPnMachine(address: string): string {
  if (address.includes(".") || address.includes("%")) return address;
  const [head = "", tail, extra] = address.split("::");
  if (extra !== undefined) return address;
  const parse = (part: string) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const groups = [...left, ...Array<number>(tail === undefined ? 0 : 8 - left.length - right.length).fill(0), ...right];
  if (groups.length !== 8 || groups.some((group) => !(group >= 0 && group <= 0xffff))) return address;
  return [...groups.slice(0, 7), 0].map((group) => group.toString(16)).join(":");
}
