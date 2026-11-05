// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_USAGE_EVENTS, USAGE_KEEP_MS } from "../src/shared/usage-ids.js";
import type { Where } from "../web/src/usage.js";

// What you used (Sam, 27 Oct): the app's recorder batches ids and numbers, sends them when the app is hidden or 50
// wait, keeps a failed batch for the next send, drops one the server can never take, and never sends any text.

type Recorder = typeof import("../web/src/usage.js");

let usage: Recorder;
let posts: { device: string; events: [number, string, string, string, number][] }[] = [];
let answer = 204;
let where: Where = { tab: "progress", desk: false, morePage: null, cards: "needs" };

async function load(): Promise<Recorder> {
  vi.resetModules();
  return import("../web/src/usage.js");
}

const events = () => posts.flatMap((post) => post.events);
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  vi.stubEnv("DEV", false);
  // happy-dom reports itself as an automated browser.
  Object.defineProperty(navigator, "webdriver", { value: false, configurable: true });
  posts = [];
  answer = 204;
  where = { tab: "progress", desk: false, morePage: null, cards: "needs" };
  localStorage.clear();
  document.body.replaceChildren();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init: RequestInit) => {
      posts.push(JSON.parse(String(init.body)));
      return new Response(answer === 204 ? null : JSON.stringify({ error: "no" }), { status: answer });
    }),
  );
  usage = await load();
  usage.startUsage(() => where);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function tap(markup: string): void {
  const holder = document.createElement("div");
  holder.innerHTML = markup;
  document.body.append(holder);
  (holder.querySelector("[data-tap]") as HTMLElement).click();
}

describe("the usage recorder", () => {
  it("records a tagged tap with its position, an untagged one as unnamed, and ignores a tap on no control", async () => {
    tap('<button data-use="cards.answer.choice" data-use-value="2"><span data-tap>Ship it</span></button>');
    tap('<button data-tap aria-label="Ship plan-6586 to Sam">Ship plan-6586</button>');
    tap('<button data-tap data-use="Ship it to Sam">x</button>');
    tap("<p data-tap>Just words</p>");
    // A link in a tagged control's text is that control.
    tap('<p data-use="cards.choice-link" data-use-value="1">See <a data-tap href="https://example.com/pr/6586">the PR</a></p>');
    usage.usageHidden();
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.device).toBe("desktop");
    const taps = events().filter(([, kind]) => kind === "tap");
    expect(taps.map(([, , id, screen, value]) => [id, screen, value])).toEqual([
      ["cards.answer.choice", "floor", 2],
      ["unnamed", "floor", 0],
      ["unnamed", "floor", 0],
      ["cards.choice-link", "floor", 1],
    ]);
  });

  it("sends no card id and no text in any body", async () => {
    usage.cardShown("plan-6586");
    usage.cardAnswered({ id: "plan-6586", kind: "plan" }, "approve");
    usage.cardAnswered({ id: "secret-card", kind: "Ship it to Sam" }, "choice");
    tap('<button data-tap data-use="cards.approve">Approve Ship it to Sam</button>');
    usage.enterScreen("decide");
    usage.useTap("cards.key.choice", 3);
    usage.leaveScreen("decide");
    usage.usageHidden();
    await settle();
    const body = JSON.stringify(posts);
    for (const text of ["plan-6586", "secret-card", "Ship it", "Approve", "Sam"]) expect(body).not.toContain(text);
    expect(events().filter(([, kind]) => kind === "card").map(([, , id]) => id)).toEqual(["card.plan.approve", "card.other.choice"]);
  });

  it("names the screen under the sheets, and gives each screen only its time on top", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    where = { tab: "more", desk: false, morePage: "machines", cards: "needs" };
    usage.screenMoved();
    vi.setSystemTime(1_001_000);
    usage.enterScreen("search");
    vi.setSystemTime(1_004_000);
    usage.enterScreen("no-such-sheet");
    vi.setSystemTime(1_004_500);
    usage.leaveScreen("search");
    vi.setSystemTime(1_006_500);
    // A wide window shows Cards in its middle column.
    where = { tab: "cards", desk: true, morePage: null, cards: "done" };
    usage.screenMoved();
    vi.setSystemTime(1_007_000);
    usage.usageHidden();
    await settle();
    // Machines: 1 s before Search came over it and 2 s after it went; Search: 3 s, not the half second the sheet over it took.
    expect(events().filter(([, kind]) => kind === "screen").map(([, , id, , value]) => [id, value])).toEqual([
      ["floor", 0],
      ["unknown", 500],
      ["search", 3000],
      ["more.machines", 3000],
      ["answered", 500],
    ]);
  });

  it("going to the background records the sheet on top before the screens under it, as closing it would (review R5.1)", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    where = { tab: "progress", desk: true, morePage: null, cards: "needs" };
    usage.screenMoved();
    vi.setSystemTime(1_060_000);
    usage.enterScreen("search");
    vi.setSystemTime(1_061_500);
    usage.usageHidden();
    await settle();
    expect(events().filter(([, kind]) => kind === "screen").map(([, , id, , value]) => [id, value]).slice(-2)).toEqual([
      ["search", 1500],
      ["progress", 60_000],
    ]);
  });

  it("records a phone's Rivet, Decide and page sheets as sheets over the Floor, never a Chat, Cards or More it did not show", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    usage = await load();
    usage.startUsage(() => where);
    const box = document.createElement("div");
    Object.defineProperty(box, "scrollHeight", { value: 2000 });
    Object.defineProperty(box, "clientHeight", { value: 1000 });
    document.body.append(box);
    usage.watchDepth(box, () => "chat");
    // A dock tap opens the sheet, and changed() reads the tab once the chat inside it has mounted; a close leaves the
    // sheet, and changed() reads the Floor's tab once the shell has painted.
    vi.setSystemTime(1_002_000);
    usage.enterScreen("floor.rivet");
    vi.setSystemTime(1_002_680);
    where = { tab: "chat", desk: false, morePage: null, cards: "needs" };
    usage.screenMoved();
    box.scrollTop = 500;
    box.dispatchEvent(new Event("scrollend"));
    vi.setSystemTime(1_003_224);
    usage.leaveScreen("floor.rivet");
    vi.setSystemTime(1_003_829);
    where = { tab: "progress", desk: false, morePage: null, cards: "needs" };
    usage.screenMoved();
    vi.setSystemTime(1_005_000);
    usage.enterScreen("decide");
    where = { tab: "cards", desk: false, morePage: null, cards: "done" };
    usage.screenMoved();
    vi.setSystemTime(1_019_725);
    usage.leaveScreen("decide");
    vi.setSystemTime(1_020_081);
    where = { tab: "progress", desk: false, morePage: null, cards: "done" };
    usage.screenMoved();
    vi.setSystemTime(1_021_000);
    usage.enterScreen("floor.page");
    where = { tab: "more", desk: false, morePage: null, cards: "done" };
    usage.screenMoved();
    usage.useTap("menu.tile.usage");
    vi.setSystemTime(1_024_000);
    usage.leaveScreen("floor.page");
    vi.setSystemTime(1_024_300);
    where = { tab: "progress", desk: false, morePage: null, cards: "done" };
    usage.screenMoved();
    vi.setSystemTime(1_025_000);
    usage.usageHidden();
    await settle();
    expect(events().filter(([, kind]) => kind !== "tap").map(([, kind, id, , value]) => [kind, id, value])).toEqual([
      ["screen", "floor.rivet", 1224],
      ["scroll", "chat", 50],
      ["screen", "decide", 14725],
      ["screen", "floor.page", 3000],
      ["screen", "floor", 2000 + 1776 + 1275 + 1000],
    ]);
    expect(events().find(([, kind]) => kind === "tap")![3]).toBe("floor.page");
  });

  it("gives a page open in its sheet its own time, since the sheet is the More tab", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    where = { tab: "more", desk: false, morePage: null, cards: "needs" };
    usage.screenMoved();
    usage.enterScreen("floor.page");
    vi.setSystemTime(1_002_000);
    where = { tab: "more", desk: false, morePage: "usage", cards: "needs" };
    usage.screenMoved();
    usage.useTap("cards.approve");
    vi.setSystemTime(1_032_000);
    where = { tab: "more", desk: false, morePage: null, cards: "needs" };
    usage.screenMoved();
    vi.setSystemTime(1_033_000);
    usage.leaveScreen("floor.page");
    usage.usageHidden();
    await settle();
    expect(events().filter(([, kind]) => kind === "screen").map(([, , id, , value]) => [id, value])).toEqual([
      ["floor", 0],
      ["more.usage", 30000],
      ["floor.page", 3000],
    ]);
    expect(events().find(([, kind]) => kind === "tap")![3]).toBe("more.usage");
  });

  it("sends Answered's depth when the Decide sheet over the Floor goes", async () => {
    const box = document.createElement("div");
    Object.defineProperty(box, "scrollHeight", { value: 2000 });
    Object.defineProperty(box, "clientHeight", { value: 1000 });
    document.body.append(box);
    let mode = "answered";
    usage.watchDepth(box, () => mode);
    usage.enterScreen("decide");
    box.scrollTop = 900;
    box.dispatchEvent(new Event("scrollend"));
    usage.leaveScreen("decide");
    mode = "decide";
    usage.enterScreen("decide");
    box.scrollTop = 200;
    box.dispatchEvent(new Event("scrollend"));
    usage.leaveScreen("decide");
    await usage.flushUsage();
    expect(events().filter(([, kind]) => kind === "scroll").map(([, , id, , value]) => [id, value])).toEqual([
      ["answered", 90],
      ["decide", 20],
    ]);
  });

  it("counts no time while the app is hidden, for a sheet that goes or comes meanwhile", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    usage.enterScreen("decide");
    vi.setSystemTime(1_002_000);
    usage.usageHidden();
    // A refresh closes Decide and opens Search while the app is away.
    vi.setSystemTime(1_060_000);
    usage.leaveScreen("decide");
    usage.enterScreen("search");
    vi.setSystemTime(1_100_000);
    usage.usageShown();
    vi.setSystemTime(1_101_000);
    usage.leaveScreen("search");
    usage.usageHidden();
    await settle();
    expect(events().filter(([, kind]) => kind === "screen").map(([, , id, , value]) => [id, value])).toEqual([
      ["decide", 2000],
      ["search", 1000],
    ]);
  });

  it("stamps each batch with the app's clock, so a batch sent again after its answer was lost names the same events", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    const bodies: { sentAt: number; events: [number, string, string, string, number][] }[] = [];
    let lose = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        // The server took it, but the page never heard: frozen in the background, or cut off.
        if (lose) throw new TypeError("Failed to fetch");
        return new Response(null, { status: 204 });
      }),
    );
    usage.useTap("cards.approve");
    vi.setSystemTime(1_000_500);
    usage.enterScreen("decide");
    vi.setSystemTime(1_002_000);
    usage.leaveScreen("decide");
    vi.setSystemTime(1_003_000);
    await usage.flushUsage();
    lose = false;
    vi.setSystemTime(1_090_000);
    await usage.flushUsage();
    expect(bodies).toHaveLength(2);
    const stamped = (body: (typeof bodies)[number]) => body.events.map(([age, kind, id, , value]) => [body.sentAt - age, kind, id, value]);
    expect(stamped(bodies[0]!)).toEqual([
      [1_000_000, "tap", "cards.approve", 0],
      [1_002_000, "screen", "decide", 1500],
    ]);
    expect(stamped(bodies[1]!)).toEqual(stamped(bodies[0]!));
  });

  it("sends 50 waiting events at once, and splits a long queue into batches the server takes", async () => {
    for (let i = 0; i < 49; i++) usage.useTap("cards.approve");
    await settle();
    expect(posts).toHaveLength(0);
    usage.useTap("cards.approve");
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.events).toHaveLength(50);

    answer = 503;
    for (let i = 0; i < 49; i++) usage.useTap("cards.approve");
    for (let i = 0; i < 300; i++) usage.useTap("cards.reject");
    await settle();
    answer = 204;
    posts = [];
    usage.usageHidden();
    await settle();
    expect(posts.map((post) => post.events.length)).toEqual([MAX_USAGE_EVENTS, 150]);
  });

  it("keeps a failed batch, up to 500, and sends it with the next one", async () => {
    answer = 503;
    for (let i = 0; i < 600; i++) usage.useTap("cards.approve");
    usage.usageHidden();
    await settle();
    expect(JSON.parse(localStorage.getItem(usage.OUTBOX_KEY) ?? "[]")).toHaveLength(usage.OUTBOX_MAX);

    answer = 204;
    posts = [];
    usage.useTap("cards.reject");
    await usage.flushUsage();
    expect(events()).toHaveLength(usage.OUTBOX_MAX);
    expect(events().at(-1)![2]).toBe("cards.reject");
    expect(localStorage.getItem(usage.OUTBOX_KEY)).toBeNull();
  });

  it("keeps a batch in the outbox until the server answers, so a page closed mid-send sends it next time", async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn((_path: string, init: RequestInit) => (inits.push(init), new Promise<Response>(() => {}))));
    for (let i = 0; i < 50; i++) usage.useTap("cards.approve");
    await settle();
    // One send at a time: the next waits for the first to be answered.
    usage.useTap("cards.reject");
    usage.usageHidden();
    await settle();
    expect(inits).toHaveLength(1);
    // Only a send from a page going away is keepalive.
    expect(inits[0]!.keepalive).toBe(false);
    expect(JSON.parse(localStorage.getItem(usage.OUTBOX_KEY) ?? "[]").filter(([, kind]: unknown[]) => kind === "tap")).toHaveLength(51);

    // The page closes with the send unanswered; the next launch sends it.
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => (posts.push(JSON.parse(String(init.body))), new Response(null, { status: 204 }))));
    usage = await load();
    usage.startUsage(() => where);
    usage.usageHidden();
    await settle();
    expect(events().filter(([, kind]) => kind === "tap")).toHaveLength(51);
    expect(localStorage.getItem(usage.OUTBOX_KEY)).toBeNull();
  });

  it("sends at 50 without an idle callback, setting no timer of its own", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    for (let i = 0; i < 50; i++) usage.useTap("cards.approve");
    await settle();
    expect(posts).toHaveLength(1);
  });

  it("drops a batch the server refuses with a 400, and an event older than the keep window", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000, toFake: ["Date"] });
    answer = 400;
    usage.useTap("cards.approve");
    await usage.flushUsage();
    expect(posts).toHaveLength(1);
    expect(localStorage.getItem(usage.OUTBOX_KEY)).toBeNull();

    answer = 503;
    usage.useTap("cards.approve");
    await usage.flushUsage();
    vi.setSystemTime(1_000_000_000_000 + USAGE_KEEP_MS + 1);
    answer = 204;
    posts = [];
    usage.useTap("cards.reject");
    await usage.flushUsage();
    expect(events().map(([t, , id]) => [t, id])).toEqual([[0, "cards.reject"]]);
  });

  it("records and sends nothing in an automated browser", async () => {
    Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
    try {
      usage = await load();
      usage.startUsage(() => where);
      tap('<button data-tap data-use="cards.approve">Approve</button>');
      usage.useTap("cards.approve");
      usage.usageHidden();
      await usage.flushUsage();
      expect(posts).toHaveLength(0);
    } finally {
      Object.defineProperty(navigator, "webdriver", { value: false, configurable: true });
    }
  });

  it("records a long view's deepest scroll once, when its screen is left, named by the nearest watched holder", async () => {
    const scroller = (parent: Element) => {
      const el = document.createElement("div");
      Object.defineProperty(el, "scrollHeight", { value: 2000 });
      Object.defineProperty(el, "clientHeight", { value: 1000 });
      parent.append(el);
      return el;
    };
    const scrolled = (el: Element, tops: number[]) => {
      for (const top of tops) {
        el.scrollTop = top;
        el.dispatchEvent(new Event("scrollend"));
      }
    };
    const view = document.createElement("main");
    document.body.append(view);
    const list = scroller(view);
    const chat = scroller(view);
    usage.watchDepth(view);
    usage.watchDepth(chat, () => "chat");
    // A wide window: each tab in the middle column, the chat beside it.
    where = { tab: "cards", desk: true, morePage: null, cards: "needs" };
    usage.screenMoved();
    scrolled(list, [300, 740, 200]);
    scrolled(chat, [500]);
    where = { tab: "more", desk: true, morePage: "code", cards: "needs" };
    usage.screenMoved();
    scrolled(list, [960]);
    where = { tab: "more", desk: true, morePage: null, cards: "needs" };
    usage.screenMoved();
    scrolled(list, [100]);
    usage.usageHidden();
    await settle();
    expect(events().filter(([, kind]) => kind === "scroll").map(([, , id, , value]) => [id, value])).toEqual([
      ["cards", 70],
      ["chat", 50],
      ["ops.timeline", 90],
    ]);
  });
});
