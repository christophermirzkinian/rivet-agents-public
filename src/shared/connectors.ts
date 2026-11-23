import { z } from "zod";

// Connectors: every linked outside account, by service, as GET /api/connectors answers. The same shape serves a
// hosted copy, whose supervisor fills it from its own connections. Only names, states and times reach the client:
// never a key, token, password or email, which the schema refuses outright.

export const SERVICE_STATES = ["connected", "attention", "not-connected"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];
export const ACCOUNT_STATES = ["ok", "stale", "signed-out", "not-read"] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

/**
 * An email, a path, a `key=value`, a word that names a credential, or a run long enough to be a key or token (base64,
 * base64url or hex). The server also runs the bridge's redactor over every label and reason before they reach this.
 */
const SECRET_SHAPED = /@|[/\\=]|passw(?:or)?d|secret|token|bearer|\bbasic\b|[A-Za-z0-9+_-]{24,}|[0-9a-f]{16,}/i;

/** The most accounts one service lists. */
export const ACCOUNTS_MAX = 20;

/** True when text could carry a secret or an email, so it never goes out. */
export const secretShaped = (text: string): boolean => SECRET_SHAPED.test(text);

/** One line of plain words: no control characters, nothing secret-shaped. */
const words = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/)
    .refine((text) => !secretShaped(text), "looks like an email or a token");

const iso = z.string().datetime();

export const accountSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    /** "Account 2", "ChatGPT 1", a channel's name, or a masked handle ("ab***"). */
    label: words(40),
    state: z.enum(ACCOUNT_STATES),
    /** When the app last read it. */
    checkedAt: iso.nullable(),
    /** Since when it has been in its state, where that is known. */
    since: iso.nullable(),
    /** The account taking the work now. */
    inUse: z.boolean().optional(),
    /** Why it is not ok, in plain words. */
    reason: words(80).optional(),
  })
  .strict();

export const serviceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    name: words(40),
    state: z.enum(SERVICE_STATES),
    accounts: z.array(accountSchema).max(ACCOUNTS_MAX),
    /** The row's state line: "1 of 4 accounts signed out", "2 accounts", "Connected". */
    line: words(80),
    /** The tile's letters for a service with no logo to show. */
    mono: z.string().regex(/^[A-Z]{1,3}$/).optional(),
    /** The sign-in buttons the detail sheet offers; absent for a service that is status only. */
    signIn: z.object({ connect: z.boolean(), reconnect: z.boolean(), add: z.boolean() }).strict().optional(),
    /** How a service with no sign-in button is connected, in plain words: "Connected on the server with a key." */
    how: words(80).optional(),
  })
  .strict();

// Signing in from the detail sheet. A sign-in runs on the site's own page; the app only ever sees the page's address,
// a short device code to type there, and how the sign-in stands. Never a key, token, password or email.

export const SIGNIN_SERVICES = ["gdrive", "github", "chatgpt", "claude"] as const;
export type SigninService = (typeof SIGNIN_SERVICES)[number];
export const SIGNIN_MODES = ["connect", "reconnect", "add"] as const;
export type SigninMode = (typeof SIGNIN_MODES)[number];
export const SIGNIN_STATES = ["starting", "waiting", "signed-in", "failed", "expired"] as const;
export type SigninState = (typeof SIGNIN_STATES)[number];

/** A sign-in's id: 32 random bytes, base64url. */
export const SIGNIN_ID = /^[A-Za-z0-9_-]{43}$/;
/** A device code as GitHub and OpenAI show it: letters and digits either side of one dash. */
export const DEVICE_CODE = /^[A-Z0-9]{4,6}-[A-Z0-9]{4,6}$/;
/**
 * The code claude.ai's last page shows, as `claude auth login` reads it: the authorization code, `#`, then the sign-in's
 * state, which the CLI makes as 32 random bytes in base64url (43 characters) and which must be this sign-in's own.
 */
export const CLAUDE_CODE = /^[A-Za-z0-9_-]{20,200}#[A-Za-z0-9_-]{43}$/;

export const signinStartSchema = z
  .object({
    service: z.enum(SIGNIN_SERVICES),
    mode: z.enum(SIGNIN_MODES),
    /** The account to sign in again, by its id in the list ("account-2", "chatgpt-0123456789ab"); reconnect only. */
    account: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  })
  .strict();

export const signinCodeSchema = z.object({ id: z.string().regex(SIGNIN_ID), code: z.string().regex(CLAUDE_CODE) }).strict();

export const signinStatusSchema = z
  .object({
    id: z.string().regex(SIGNIN_ID),
    service: z.enum(SIGNIN_SERVICES),
    state: z.enum(SIGNIN_STATES),
    /** The site's own sign-in page, on that provider's host. */
    url: z.string().url().max(2048).optional(),
    /** The device code to type on that page. */
    userCode: z.string().regex(DEVICE_CODE).optional(),
    /** The page will show a code to bring back here (Claude). */
    needsCode: z.boolean().optional(),
    expiresAt: iso,
  })
  .strict();

export type SigninStart = z.infer<typeof signinStartSchema>;
export type SigninStatus = z.infer<typeof signinStatusSchema>;

export const connectorsResponseSchema = z.object({ at: iso, services: z.array(serviceSchema).max(40) }).strict();

export type ConnectorAccount = z.infer<typeof accountSchema>;
export type ConnectorService = z.infer<typeof serviceSchema>;
export type ConnectorsResponse = z.infer<typeof connectorsResponseSchema>;

/** The services needing attention: the menu's red count. */
export const attentionCount = (body: Pick<ConnectorsResponse, "services"> | null): number => body?.services.filter((one) => one.state === "attention").length ?? 0;

/** A service's state line from its accounts. */
export function serviceLine(state: ServiceState, accounts: readonly Pick<ConnectorAccount, "state">[]): string {
  if (state === "not-connected") return "Not set up";
  const n = accounts.length;
  const out = accounts.filter((one) => one.state === "signed-out").length;
  if (out) return n === 1 ? "Signed out" : `${out} of ${n} accounts signed out`;
  const unread = accounts.filter((one) => one.state !== "ok").length;
  if (unread) return n === 1 ? "Not read lately" : `${unread} of ${n} accounts not read lately`;
  return n > 1 ? `${n} accounts` : "Connected";
}

/** A service from its accounts: attention while one is signed out, not connected with none. */
export function serviceOf(id: string, name: string, accounts: ConnectorAccount[], mono?: string): ConnectorService {
  const state: ServiceState = !accounts.length ? "not-connected" : accounts.some((one) => one.state === "signed-out") ? "attention" : "connected";
  return { id, name, state, accounts, line: serviceLine(state, accounts), ...(mono ? { mono } : {}) };
}
