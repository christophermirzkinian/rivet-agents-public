// &mind=setup in the login-free preview: a hosted machine with no map, its supervisor's questions and list
// (rivet-agents runtime/mind-setup.json).
const option = (id: string, title: string, note = "") => ({ id, title, note });
const SETUP = {
  questions: [
    { id: "write", title: "How should {agent} write to you?", options: [option("short", "Short", "The answer first. More only if you ask."), option("reasons", "With reasons", "The answer, then why, in a few lines."), option("steps", "Step by step", "Explain as you go, with no jargon.")] },
    { id: "check", title: "When should {agent} check with you?", options: [option("plan", "Show me a plan first", "Before any job that changes something."), option("unsure", "Ask if unsure", "Start clear jobs. One question if not."), option("big", "Only for big things", "Anything you can't undo, or that costs money.")] },
    { id: "code", title: "How much do you know about code?", options: [option("none", "None", "Say what it does, not how."), option("little", "A little", "Explain anything technical in a sentence."), option("writes", "I write code", "Show me the files changed and why.")] },
    { id: "help", title: "What do you want help with most?", options: [option("build", "Apps and websites"), option("bugs", "Fixing my code"), option("chores", "Routine jobs"), option("reports", "Reports and data"), option("explain", "Explaining code")] },
    { id: "update", title: "How often should {agent} update you?", options: [option("done", "When it's done", "Nothing in between, unless it needs you."), option("along", "Along the way", "At the start, each main step and the end."), option("needed", "Only if it needs me", "Questions and problems only.")] },
  ],
  list: [
    { title: "Notes to keep", lines: [{ id: "asked", say: "I want a list of everything I've asked for" }, { id: "decisions", say: "I want my decisions written down, with the reason" }, { id: "project-page", say: "I want a notes page for each project" }, { id: "my-words", say: "I have my own words for things" }] },
    { title: "Skills", lines: [{ id: "plain-words", say: "I want plain words in anything others will read" }, { id: "explain-example", say: "I like things explained with an example" }, { id: "before-public", say: "I want a check before anything goes public" }, { id: "week", say: "I want a summary of my week when I ask" }] },
    {
      title: "Ways of working",
      lines: [
        { id: "clock", say: "I want the clock checked before I'm given a time" },
        { id: "run-fix", say: "I want a fix run before I'm told it works" },
        { id: "small", say: "I want small jobs kept small" },
        { id: "late", say: "I want to hear early if something will be late" },
        { id: "not-a-yes", say: "My answer to a question is not a yes to start" },
        { id: "seen", say: "I want the new version seen before I'm told it's up" },
        { id: "fresh-search", say: 'I want a fresh search before "nothing found"' },
        { id: "same-mistake", say: "I want the same mistake looked for elsewhere" },
        { id: "read-change", say: "I want every change read before it's merged" },
        { id: "not-done", say: "I want to be told what wasn't done" },
        { id: "one-question", say: "I want one question at a time" },
      ],
    },
  ],
};

const on = new URLSearchParams(location.search).get("mind") === "setup";
const picked = new Map<string, string>();
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** The hosted machine's own answers, and its empty map; null for anything else, and when this preview is not one. */
export function mindSetupPreview(url: string, body: unknown): Response | null {
  if (!on) return null;
  if (url === "/api/mind") return json({ graph: null, receivedAt: null });
  if (url === "/cloud/agent") return json({ name: "Pip", setupDone: true, firstPlan: "claude" });
  if (url === "/cloud/mind/set" && body instanceof URLSearchParams) {
    picked.set(String(body.get("id")), String(body.get("value")));
    return json({ result: "set", codex: true });
  }
  if (url !== "/cloud/mind") return null;
  const of = (value: string) => [...picked].filter((one) => one[1] === value).map((one) => one[0]);
  const answers = Object.fromEntries([...picked].filter(([id]) => SETUP.questions.some((q) => q.id === id)));
  return json({ ...SETUP, state: { kind: picked.size ? "present" : "none", answers, yes: of("true"), no: of("false") } });
}
