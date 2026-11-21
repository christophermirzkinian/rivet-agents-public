// A hosted machine puts its supervisor in front of the app on the same origin and serves /cloud/*. Its /cloud/agent,
// for the signed-in owner only, is the one test of a hosted build. Its JSON 404 means the owner's own machine, and nothing here
// changes what it shows; any other miss (a network error, a 5xx, a redirect, a page in place of JSON) is asked again.
import { APP_NAME, appName, checkedAgentName, checkedAppName, RIVET_NAME, nameHostedAgent, UNNAMED_AGENT } from "../../src/shared/names.js";

export interface CloudAgent {
  name: string | null;
  setupDone: boolean;
  firstPlan: "claude" | "chatgpt";
  /** The app's name the host gives it; null keeps the build's own. */
  app: string | null;
}

export interface Plans {
  claude: boolean;
  chatgpt: boolean;
}

/** The supervisor's own page: a full page load, never the app's router. */
export const CONNECT_PATH = "/cloud/setup/connect";
const BAND_ID = "cloud-connect";
const RETRY_MS = [5_000, 15_000, 60_000];
const ENROL_RETRY_MS = [1_000, 2_000, 4_000];

let hosted: CloudAgent | null = null;
let plans: Plans | null = null;
/** The probe had a definite answer that this is not a hosted machine. */
let notHosted = false;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let onFocus: (() => void) | null = null;
/** One per signed-in stretch: a read still on its way at a sign-out shows nothing. */
let session = 0;

export function parseAgent(body: unknown): CloudAgent | null {
  if (!body || typeof body !== "object") return null;
  const { name, setupDone, firstPlan, app, unknown } = body as Record<string, unknown>;
  // `unknown` is a supervisor that can't tell yet whether setup is done (agent.json unwritten): never read as not set up.
  if (typeof setupDone !== "boolean" && unknown !== true) return null;
  return { name: checkedAgentName(name), setupDone: unknown === true || setupDone === true, firstPlan: firstPlan === "chatgpt" ? "chatgpt" : "claude", app: checkedAppName(app) };
}

/** The app's name the server put in the page it served (static.ts): a hosted machine's host's, before anyone signs in. */
let servedApp: string | null = null;
/** The server marked the page as a hosted machine's, whatever its app is named. */
let servedHosted = false;

export function readServedApp(): void {
  const app = checkedAppName(document.querySelector('meta[name="application-name"]')?.getAttribute("content"));
  servedApp = app === APP_NAME ? null : app;
  servedHosted = document.querySelector('meta[name="hosted-agent"]') !== null;
  if (!hosted) nameNoAgent();
}

/** No agent read yet: a hosted machine's agent is UNNAMED_AGENT, as the server's is. */
const nameNoAgent = (): void => nameHostedAgent(servedHosted ? UNNAMED_AGENT : null, servedApp);

/** An older supervisor sends only `loggedIn`, which was Claude's. */
export function parsePlans(body: unknown): Plans | null {
  if (!body || typeof body !== "object") return null;
  const { claude, chatgpt, loggedIn } = body as Record<string, unknown>;
  const hasClaude = typeof claude === "boolean" ? claude : typeof loggedIn === "boolean" ? loggedIn : null;
  if (hasClaude === null) return null;
  return { claude: hasClaude, chatgpt: chatgpt === true };
}

/**
 * `absent`: the path is not served here at all, the owner's own server's JSON 404 (`{ error }`). A redirect (a sign-in
 * or wake page on the way), a page in place of JSON or a 404 of any other kind says nothing either way.
 */
type Read = { body: unknown } | { absent: boolean };

async function readJson(path: string): Promise<Read> {
  try {
    const response = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (response.redirected) return { absent: false };
    const json = (response.headers.get("content-type") ?? "").includes("application/json");
    if (response.ok && json) return { body: await response.json() };
    if (response.status !== 404 || !json) return { absent: false };
    const body: unknown = await response.json().catch(() => null);
    return { absent: !!body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" };
  } catch {
    return { absent: false };
  }
}

const bodyOf = (read: Read): unknown => ("body" in read ? read.body : null);

/** A probe started before a sign-out changes nothing and answers null. */
export async function probeCloud(): Promise<CloudAgent | null> {
  const at = session;
  const read = await readJson("/cloud/agent");
  if (at !== session) return null;
  hosted = parseAgent(bodyOf(read)) ?? hosted;
  if (hosted) nameHostedAgent(hosted.name ?? UNNAMED_AGENT, hosted.app ?? servedApp);
  if (!hosted && "absent" in read && read.absent) notHosted = true;
  return hosted;
}

/**
 * Just after a passkey is made: true only on a definite answer that this is the owner's own machine. A hosted machine's
 * supervisor sends a fresh agent from / to its set-up, so one that is hosted, or never answers, loads / again.
 */
export async function ownMachineAfterEnrol(): Promise<boolean> {
  const at = session;
  for (const wait of [0, ...ENROL_RETRY_MS]) {
    if (wait) await new Promise((done) => setTimeout(done, wait));
    if ((await probeCloud()) || at !== session) return false;
    if (notHosted) return true;
  }
  return false;
}

/** A hosted machine's page: the server marked it, or the probe found its supervisor. Every hosted-or-owner choice reads this. */
export const hostedPage = (): boolean => servedHosted || hosted !== null;

export const agentName = (): string => (hostedPage() ? (hosted?.name ?? UNNAMED_AGENT) : RIVET_NAME);

/** After "your": "your agent" on a hosted machine, "your Rivet" on the owner's own. */
export const agentNoun = (): string => (hostedPage() ? "agent" : RIVET_NAME);

export const tabTitle = (name: string): string => name;

/** Only once the supervisor has said neither plan is connected; an unread status shows nothing. */
export const needsPlan = (): boolean => hosted !== null && plans !== null && !plans.claude && !plans.chatgpt;

export function connectPlan(): void {
  location.assign(CONNECT_PATH);
}

function showBand(on: boolean): void {
  const band = document.getElementById(BAND_ID);
  if (!on) return band?.remove();
  if (band) return;
  const link = document.createElement("a");
  link.id = BAND_ID;
  link.href = CONNECT_PATH;
  link.setAttribute("data-use", "cloud.connect-band");
  link.textContent = "Connect a plan →";
  // Over the app in the body's flow, not beside the body as the cap band is: sheets keep the whole screen (styles.css).
  document.body.prepend(link);
}

/**
 * On a hosted machine, its agent's name, the tab's title and the Connect a plan band, read again at each call (the
 * app's start and each return to it); `onChange` redraws what shows the name. On the owner's own machine, one probe at
 * start and nothing after; a probe that missed is asked again until one answers either way.
 */
export async function readCloud(onChange: () => void): Promise<void> {
  if (notHosted) return;
  const at = session;
  const agent = await probeCloud();
  if (at !== session) return;
  if (!agent) return notHosted ? stopRetries() : retryLater(onChange);
  stopRetries();
  document.title = tabTitle(agentName());
  const status = parsePlans(bodyOf(await readJson("/cloud/connect/status")));
  if (at !== session) return;
  plans = status ?? plans;
  showBand(needsPlan());
  onChange();
}

/** Besides the app's return (main.ts): its window's focus, and a short backoff. */
function retryLater(onChange: () => void): void {
  if (!onFocus) {
    onFocus = () => void readCloud(onChange);
    window.addEventListener("focus", onFocus);
  }
  if (retryTimer !== undefined || retries >= RETRY_MS.length) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void readCloud(onChange);
  }, RETRY_MS[retries++]);
}

function stopRetries(): void {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  if (onFocus) window.removeEventListener("focus", onFocus);
  onFocus = null;
}

/**
 * At a sign-out: the agent's name, the band and the plans read are the signed-in owner's, and the next sign-in reads
 * them again; the tab and the page go back to the served app's name.
 */
export function leaveCloud(): void {
  session += 1;
  stopRetries();
  retries = 0;
  plans = null;
  hosted = null;
  nameNoAgent();
  document.title = appName();
  document.getElementById(BAND_ID)?.remove();
}

/** For tests. */
export function resetCloud(): void {
  stopRetries();
  hosted = null;
  servedApp = null;
  servedHosted = false;
  nameHostedAgent(null);
  plans = null;
  notHosted = false;
  retries = 0;
  if (typeof document !== "undefined") document.getElementById(BAND_ID)?.remove();
}
