// A hosted machine puts its supervisor in front of the app on the same origin and serves /cloud/*. Its /cloud/agent,
// for the signed-in owner only, is the one test of a hosted build. Its JSON 404 means the owner's own machine, and nothing here
// changes what it shows; any other miss (a network error, a 5xx, a redirect, a page in place of JSON) is asked again.
import { fellAsleep, heardAnswer, isAsleep, isBackground, onWake } from "./rivet-sleep.js";
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
/** Under every message box while no plan is connected, and what a refused send says. */
export const LOCKED_LINE = "Sending is off until Claude or ChatGPT is connected.";
const RETRY_MS = [5_000, 15_000, 60_000];
const ENROL_RETRY_MS = [1_000, 2_000, 4_000];

let hosted: CloudAgent | null = null;
let plans: Plans | null = null;
/** The probe had a definite answer that this is not a hosted machine. */
let notHosted = false;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let onFocus: (() => void) | null = null;
/** An asleep page's retry: the next read waits for the wake. */
let unwake: (() => void) | null = null;
/** The last read's `onChange`: a refused send redraws what a read would. */
let redraw: (() => void) | null = null;
/** One per refused write (noPlan): a plans read sent before it is older than what it said. */
let planSeq = 0;
const PLAN_POLL_MS = 15_000;
let planTimer: ReturnType<typeof setInterval> | undefined;
let onPlanFocus: (() => void) | null = null;
let planUnwake: (() => void) | null = null;
let planRead: Promise<void> | null = null;
let planApplied = 0;
const STATUS_TIMEOUT_MS = 10_000;
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

/** With `ms`, a read still out after it says nothing either way. */
async function readJson(path: string, ms?: number): Promise<Read> {
  if (ms === undefined) return readOnce(path);
  const stop = new AbortController();
  const late = new Promise<Read>((done) => stop.signal.addEventListener("abort", () => done({ absent: false })));
  const timer = setTimeout(() => stop.abort(), ms);
  try {
    return await Promise.race([readOnce(path, stop.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A read with no tap or key just before it (the locked desk's plan poll, a retry's timer) says so, as api.ts's reads do:
 * a hosted machine's idle watch counts it as no visit, so a desk left open sleeps on time. Asleep, it is not sent; a
 * window's focus is not a visit either (the OS can focus a window no one is at), and the next tap or key reads again.
 * From an answer only the asleep mark and the cap are taken: the cap band is cleared by the app's answers (api.ts),
 * never a /cloud read's.
 */
async function readOnce(path: string, signal?: AbortSignal): Promise<Read> {
  const background = isBackground();
  if (background && isAsleep()) return { absent: false };
  const headers: Record<string, string> = background ? { accept: "application/json", "x-rivet-background": "1" } : { accept: "application/json" };
  try {
    const response = await fetch(path, { credentials: "same-origin", headers, signal });
    if (response.headers?.get?.("x-rivet-asleep") === "1") {
      if (response.headers.get("x-rivet-capped-until") !== null) heardAnswer(response);
      else fellAsleep();
    }
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

/** The Mind page's questions and what is picked (views/mind-setup.ts); a JSON 404 is an older supervisor without them. */
export const readMindSetup = (): Promise<Read> => readJson("/cloud/mind", STATUS_TIMEOUT_MS);

/** One tap on the Mind page, ids only: the supervisor's own result word, null when none came back. */
export async function saveMindSetup(id: string, value: string): Promise<string | null> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), STATUS_TIMEOUT_MS);
  try {
    const response = await fetch("/cloud/mind/set", { method: "POST", credentials: "same-origin", redirect: "error", headers: { accept: "application/json" }, body: new URLSearchParams({ id, value }), signal: stop.signal });
    const { result } = (await response.json()) as { result?: unknown };
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
export const needsPlan = (): boolean => hostedPage() && plans !== null && !plans.claude && !plans.chatgpt;

export function connectPlan(): void {
  location.assign(CONNECT_PATH);
}

/**
 * The hosted proxy refused a write for want of a plan (api.ts): the plan was signed out while the page was open, so the
 * plans read is none connected from here until the next read. False, with nothing changed, on the owner's own machine.
 */
export function noPlan(): boolean {
  if (!hostedPage()) return false;
  planApplied = ++planSeq;
  plans = { claude: false, chatgpt: false };
  redraw?.();
  watchPlan();
  return true;
}

/**
 * The plans read. Each read and each refused write takes the next number, and an answer older than the newest applied
 * is dropped. True when it changed the plans.
 */
async function readStatus(): Promise<boolean> {
  const at = session;
  const seq = ++planSeq;
  const status = parsePlans(bodyOf(await readJson("/cloud/connect/status", STATUS_TIMEOUT_MS)));
  if (at !== session || !status || seq <= planApplied) return false;
  planApplied = seq;
  const changed = status.claude !== plans?.claude || status.chatgpt !== plans?.chatgpt;
  plans = status;
  return changed;
}

/** A locked desk's status read: the page redraws only when a plan came or went. */
async function readPlans(): Promise<void> {
  if (await readStatus()) redraw?.();
  watchPlan();
}

/**
 * While no plan is connected and the tab is in front: the plans read again every PLAN_POLL_MS and at the window's
 * focus, so a plan connected elsewhere lifts the lock with no reload. A hidden tab stops; its return reads (main.ts).
 */
function watchPlan(): void {
  const on = needsPlan() && !!redraw && document.visibilityState !== "hidden";
  if (!on) return stopWatch();
  const read = () => {
    if (document.visibilityState === "hidden") return stopWatch();
    if (!planRead) planRead = readPlans().finally(() => (planRead = null));
  };
  planTimer ??= setInterval(read, PLAN_POLL_MS);
  // An asleep page sends no timed or focus read: its wake (a tap or key) reads at once.
  planUnwake ??= onWake(read);
  if (!onPlanFocus) {
    onPlanFocus = read;
    window.addEventListener("focus", onPlanFocus);
  }
}

function stopWatch(): void {
  clearInterval(planTimer);
  planTimer = undefined;
  if (onPlanFocus) window.removeEventListener("focus", onPlanFocus);
  onPlanFocus = null;
  planUnwake?.();
  planUnwake = null;
}

/**
 * On a hosted machine, its agent's name, the tab's title and whether a plan is connected, read again at each call (the
 * app's start and each return to it); `onChange` redraws what shows the name, the home screen's connect box and the locked
 * message boxes (views/plan-lock.ts). On the owner's own machine, one probe at start and nothing after; a probe that
 * missed is asked again until one answers either way.
 */
export async function readCloud(onChange: () => void): Promise<void> {
  if (notHosted) return;
  redraw = onChange;
  const at = session;
  const agent = await probeCloud();
  if (at !== session) return;
  if (!agent) return notHosted ? stopRetries() : retryLater(onChange);
  stopRetries();
  document.title = tabTitle(agentName());
  await readStatus();
  if (at !== session) return;
  onChange();
  watchPlan();
}

/**
 * Besides the app's return (main.ts): its window's focus, and a short backoff. Asleep, a timer would send nothing and
 * spend a retry, so the next read waits for the wake (a tap or key).
 */
function retryLater(onChange: () => void): void {
  if (!onFocus) {
    onFocus = () => void readCloud(onChange);
    window.addEventListener("focus", onFocus);
  }
  if (isAsleep()) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    unwake ??= onWake(() => {
      unwake?.();
      unwake = null;
      void readCloud(onChange);
    });
    return;
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
  unwake?.();
  unwake = null;
  if (onFocus) window.removeEventListener("focus", onFocus);
  onFocus = null;
}

/**
 * At a sign-out: the agent's name and the plans read are the signed-in owner's, and the next sign-in reads them again;
 * the tab and the page go back to the served app's name.
 */
export function leaveCloud(): void {
  session += 1;
  stopRetries();
  stopWatch();
  retries = 0;
  plans = null;
  hosted = null;
  redraw = null;
  nameNoAgent();
  document.title = appName();
}

/** For tests. */
export function resetCloud(): void {
  stopRetries();
  stopWatch();
  hosted = null;
  servedApp = null;
  servedHosted = false;
  nameHostedAgent(null);
  plans = null;
  notHosted = false;
  retries = 0;
  redraw = null;
  planRead = null;
}
