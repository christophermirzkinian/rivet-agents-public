import { z } from "zod";

// What you used: the app records which screens you open and which controls you tap, by the fixed ids below and nothing
// else: never a message, a title, an answer, a search or anything typed. The server stores an event only when its id is
// in this registry, so no text can reach the table.

/** The day recording starts: every id first counts from here, so none is "never used" before 30 days have passed. */
export const RECORDING_START = "2026-10-28";

/** How long raw events are kept. */
export const USAGE_KEEP_DAYS = 90;
export const USAGE_KEEP_MS = USAGE_KEEP_DAYS * 24 * 60 * 60 * 1000;

/** One batch: at most this many events, in at most this many bytes. */
export const MAX_USAGE_EVENTS = 200;
export const MAX_USAGE_BYTES = 32 * 1024;
/** Batches a minute: one each time the app is hidden and one per 50 events leaves room to spare. */
export const USAGE_BATCHES_PER_MINUTE = 60;
/** Events a device may send in a day, counted when the server took them: a runaway client cannot grow the table past it. */
export const MAX_USAGE_EVENTS_PER_DAY = 5000;

/**
 * - `screen`: a tab, page, sheet or overlay was on top; value is the ms it stayed there.
 * - `control`: a named button, key or gesture; value is the choice's position (1, 2, 3…) in a family, otherwise 0.
 * - `card`: a card answered, minimised or undone; value is the ms from first shown to that answer.
 */
export type UsageIdKind = "screen" | "control" | "card";

export interface UsageId {
  id: string;
  kind: UsageIdKind;
  /** Plain words for What you used, e.g. "Answer a card". */
  label: string;
  /** Where it lives in the app, e.g. "Cards". */
  where: string;
  /** The day it was added (YYYY-MM-DD); it is left off "never used" until 30 days after. */
  added: string;
  /** A long view whose deepest scroll is recorded, in 10% steps. */
  scroll?: true;
  /** A position family: one id, the value says which (1-based). */
  family?: true;
  /** Bookkeeping, never a feature: left off What you used's lists. */
  meta?: true;
  /** The day the app stopped showing it (YYYY-MM-DD): kept, never renamed, but never offered for Retire?. */
  removed?: string;
  /** Used signed out, before the recorder starts, so never recorded: left off What you used's lists. */
  signedOut?: true;
  /** Shows or matters only when something breaks or is set up, so a zero says little: What you used reads it "can't tell". */
  setup?: true;
}

type Entry = [id: string, label: string, extra?: Partial<Pick<UsageId, "scroll" | "family" | "meta" | "signedOut" | "added" | "removed" | "setup">>];

function group(kind: UsageIdKind, where: string, entries: Entry[]): UsageId[] {
  return entries.map(([id, label, extra]) => ({ id, kind, label, where, added: RECORDING_START, ...extra }));
}

const SCREENS = group("screen", "Screens", [
  ["gate", "Sign-in screen", { signedOut: true }],
  ["floor", "Floor"],
  ["readings", "Floor readings", { removed: "2026-11-03" }],
  ["desks.rest", "More at work"],
  ["desks.chat", "A map row's chat"],
  ["desks.backlog", "A project's backlog", { added: "2026-11-02" }],
  ["progress", "Floor (wide window)"],
  ["cards", "Cards", { scroll: true }],
  ["decide", "Decide sheet", { scroll: true }],
  ["decide.via-push", "Decide opened from a push"],
  ["decide.via-link", "Decide opened from a link"],
  ["tab.via-link", "A tab opened from a link"],
  ["answered", "Answered", { scroll: true }],
  ["updates.thread", "An update's thread"],
  ["search", "Search"],
  ["chat", "Chat", { scroll: true }],
  ["chat.thing", "A thing in chat"],
  ["more", "More", { removed: "2026-11-03" }],
  ["more.usage", "Usage"],
  ["more.costs", "More › Costs", { removed: "2026-11-03" }],
  ["more.mind", "Rivet's mind", { added: "2026-11-03" }],
  ["more.machines", "Machines"],
  ["more.scheduled", "More › Scheduled", { removed: "2026-11-03" }],
  ["more.home", "Home Assistant"],
  ["more.media", "Media"],
  ["more.settings", "Settings"],
  ["more.what-you-used", "What you used"],
  ["ops.code", "Code"],
  ["ops.timeline", "Timeline", { scroll: true }],
  ["worker", "Worker sheet"],
  ["findwork", "Find work", { removed: "2026-11-02" }],
  ["ticket", "Agent ticket", { removed: "2026-11-02" }],
  ["reject", "Reject sheet"],
  ["share", "Share sheet"],
  ["patch-notes", "Patch notes"],
  ["stop-confirm", "Stop confirm", { setup: true }],
  ["coming.sheet", "Coming sheet"],
  ["shortcuts", "Keyboard shortcuts"],
  ["rivet-summary", "Rivet's copy sheet"],
  ["briefing.past", "A past briefing"],
  ["scheduled.ask", "Pause or delete a job", { setup: true }],
  ["ops.status", "A status sheet", { setup: true }],
  ["floor.list", "In hand or Done today", { removed: "2026-11-03" }],
  ["floor.rivet", "Rivet's chat on the Floor"],
  ["floor.page", "A menu page over the Floor", { added: "2026-11-03" }],
  ["menu", "Menu", { added: "2026-11-03" }],
  ["jobs.red", "Red jobs", { added: "2026-11-03" }],
  ["unknown", "A screen with no id", { meta: true }],
]);

const CONTROLS: UsageId[] = [
  ...group("control", "Anywhere", [
    ["unnamed", "A button with no id", { meta: true }],
    ["toast.undo", "Undo on a toast", { setup: true }],
    ["dictation.mic", "Dictation mic", { setup: true }],
    ["link.text", "A link in text"],
  ]),
  ...group("control", "Sign-in", [
    ["gate.signin", "Sign in", { signedOut: true }],
    ["gate.enrol", "Set up this device", { signedOut: true }],
    ["gate.signin-existing", "Sign in with a saved passkey", { signedOut: true }],
  ]),
  ...group("control", "Floor", [
    ["floor.inhand.open", "Open In hand", { removed: "2026-11-03" }],
    ["floor.done.open", "Open Done", { removed: "2026-11-03" }],
    ["floor.machines.open", "Open Machines", { removed: "2026-11-03" }],
    ["floor.readings.open", "Open readings", { removed: "2026-11-03" }],
    ["floor.wide.inhand", "Open In hand (wide window)", { removed: "2026-11-03" }],
    ["floor.wide.done", "Open Done today (wide window)", { removed: "2026-11-03" }],
    ["floor.wide.machines", "Open Machines (wide window)", { removed: "2026-11-03" }],
    ["floor.wide.decide", "Open Decide under the Floor (wide window)"],
    ["floor.band.inhand", "In hand tile", { removed: "2026-11-03" }],
    ["floor.band.done", "Done tile", { removed: "2026-11-03" }],
    ["floor.band.usage", "Usage tile", { removed: "2026-11-04" }],
    ["floor.brief.cards", "Brief: cards", { removed: "2026-11-04" }],
    ["floor.brief.prs", "Brief: PRs", { removed: "2026-11-04" }],
    ["floor.brief.chats", "Brief: chats", { removed: "2026-11-04" }],
    ["floor.brief.jobs", "Brief: jobs", { removed: "2026-11-04" }],
    ["floor.brief.claude", "Brief: Claude", { removed: "2026-11-04" }],
    ["floor.line.cards", "Band line: cards wait", { added: "2026-11-04" }],
    ["floor.line.due", "Band line: a job due within the hour", { added: "2026-11-04" }],
    ["floor.line.machine", "Band line: a machine needs a look", { added: "2026-11-04" }],
    ["floor.line.usage", "Band line: Usage near its cap", { added: "2026-11-04" }],
    ["floor.dock.decide", "Dock: Decide"],
    ["floor.dock.rivet", "Dock: Rivet"],
    ["floor.list.close", "Close a Floor list"],
    ["floor.team-room", "Open the Team room", { removed: "2026-11-12" }],
    ["floor.readings.back", "Back from readings", { removed: "2026-11-03" }],
    ["floor.pull-refresh", "Pull to refresh"],
  ]),
  ...group("control", "Computer shell", [
    ["shell.rail.floor", "Rail: Floor", { removed: "2026-11-03" }],
    ["shell.rail.readings", "Rail: Readings", { removed: "2026-11-03" }],
    ["shell.rail.chat", "Rail: Chat"],
    ["shell.rail.settings", "Rail: Settings", { removed: "2026-11-03" }],
    ["shell.rail.fold", "Fold the rail"],
    ["shell.header.back", "Header back", { removed: "2026-11-03" }],
    ["shell.header.floor", "Header: back to the Floor"],
    ["shell.header.focus", "Focus mode"],
    ["shell.key.search", "Key: search"],
    ["shell.key.shortcuts", "Key: shortcuts"],
    ["shell.key.chat-pane", "Key: chat pane"],
    ["shell.key.rail", "Key: rail"],
    ["shell.key.focus", "Key: focus"],
    ["pane.fold", "Fold a pane"],
    ["pane.strip", "Pane strip"],
    ["status.cards", "Status line: cards", { setup: true }],
    ["status.prs", "Status line: PRs", { setup: true }],
    ["status.chats", "Status line: chats", { setup: true }],
    ["status.jobs", "Status line: jobs", { setup: true }],
    ["status.claude", "Status line: Claude", { setup: true }],
  ]),
  ...group("control", "Decide sheet", [
    ["decide.skip", "Skip a card"],
    ["decide.close", "Close Decide"],
    ["decide.seg.open", "Decide: Open"],
    ["decide.seg.answered", "Decide: Answered"],
    ["decide.handle.drag", "Drag Decide down"],
    ["decide.backdrop", "Tap outside Decide"],
    ["decide.escape", "Escape out of Decide"],
    ["decide.back", "Back out of Decide"],
    ["decide.show-minimised", "Show minimised cards in Decide"],
    ["decide.big", "See it big in Decide"],
    ["decide.retry", "Try again when Decide could not read the cards", { added: "2026-11-10" }],
  ]),
  ...group("control", "Cards", [
    ["cards.offline.retry", "Retry when offline"],
    ["cards.push-banner.on", "Turn on push from the banner"],
    ["cards.thread.open", "Open a card's thread"],
    ["cards.minimise", "Minimise a card"],
    ["cards.reject", "Reject a card"],
    ["cards.answer.choice", "Answer a card", { family: true }],
    ["cards.choice-link", "A link in an option"],
    ["cards.link", "A link on a card"],
    ["cards.message-rivet", "Message Rivet"],
    ["cards.share", "Share a card"],
    ["cards.confirm.yes", "Confirm an answer"],
    ["cards.confirm.cancel", "Cancel a confirm"],
    ["cards.pick-hint", "Pick hint"],
    ["cards.min-open", "Open a minimised card"],
    ["cards.say.mic", "Speak on a card"],
    ["cards.say.attach", "Attach to a card"],
    ["cards.say.send", "Send a comment"],
    ["cards.todo.open", "Open a to-do"],
    ["cards.todo.done", "Done on a to-do"],
    ["cards.plan.yes", "Yes to a plan"],
    ["cards.plan.no", "No to a plan"],
    ["cards.send-answer", "Send an answer"],
    ["cards.approve", "Approve a card"],
    ["cards.reject.send", "Send a rejection"],
    ["cards.reject.cancel", "Cancel a rejection"],
    ["cards.undo", "Undo an answer"],
    ["cards.key.next", "Key: next card"],
    ["cards.key.prev", "Key: previous card"],
    ["cards.key.approve", "Key: approve"],
    ["cards.key.reject", "Key: reject"],
    ["cards.key.later", "Key: later"],
    ["cards.key.comment", "Key: comment"],
    ["cards.key.undo", "Key: undo"],
    ["cards.key.choice", "Key: pick an option", { family: true }],
    ["cards.key.enter", "Key: enter"],
    ["cards.key.yes", "Key: yes"],
    ["cards.key.esc", "Key: escape"],
    ["cards.desk.send", "Send (computer)"],
    ["cards.desk.approve", "Approve (computer)"],
    ["cards.desk.comment", "Comment (computer)"],
    ["cards.desk.attach", "Attach (computer)"],
    ["cards.desk.mic", "Mic (computer)"],
  ]),
  ...group("control", "Updates", [
    ["updates.pile.open", "Open an update"],
    ["updates.pile.say", "Reply to an update"],
    ["updates.pile.share", "Share an update"],
    ["updates.pile.seen", "Mark an update seen"],
  ]),
  ...group("control", "Answered", [
    ["answered.window.6h", "Answered: 6 hours"],
    ["answered.window.12h", "Answered: 12 hours"],
    ["answered.window.24h", "Answered: 24 hours"],
    ["answered.window.48h", "Answered: 48 hours"],
    ["answered.window.all", "Answered: all"],
    ["answered.show-done", "Answered: show done"],
    ["answered.reopen", "Reopen a card"],
    ["answered.send-again", "Send a reopen again"],
  ]),
  ...group("control", "Search", [
    ["search.enter", "Enter in Search"],
    ...(["card", "coming", "shipped", "waiting", "answer", "worker", "pr", "app", "timeline", "briefing", "agent", "chat"].map(
      (hit): Entry => [`search.hit.${hit}`, `Search result: ${hit}`],
    )),
  ]),
  ...group("control", "Chat", [
    ["chat.speak.toggle", "Read chat aloud"],
    ["chat.search.clear", "Clear find in chat"],
    ["chat.search.hit", "A find-in-chat hit"],
    ["chat.earlier", "Earlier messages"],
    ["chat.retry", "Try again when a chat could not be read", { added: "2026-11-10" }],
    ["chat.topics.open", "Open more topics"],
    ["chat.topics.back", "Back from more topics"],
    ["chat.topics.archived", "Show archived topics"],
    ["chat.topics.row", "A topic in more topics"],
    ["chat.compose.attach", "Attach to a message"],
    ["chat.compose.mic", "Speak a message"],
    ["chat.compose.send", "Send a message"],
    ["chat.reply.cancel", "Cancel a reply"],
    ["chat.msg.tools-toggle", "Show a message's tools"],
    ["chat.msg.reply", "Reply to a message"],
    ["chat.msg.share", "Share a message"],
    ["chat.msg.open-card", "Open a message's card"],
    ["chat.msg.card-line", "A card line in chat"],
    ["chat.msg.quote-jump", "Jump to a quote"],
    ["chat.msg.image", "A photo in chat"],
    ["chat.msg.file", "A file in chat"],
    ["chat.thing.link", "A thing's link"],
    ["chat.thing.back", "Back from a thing"],
    ["chat.thing.open-card", "Open a thing's card"],
    ["chat.thing.stop", "Stop a thing"],
    ["chat.thing.stop-confirm", "Confirm stop"],
    ["chat.thing.share", "Share a thing"],
    ["chat.share.send", "Send a share"],
    ["chat.share.cancel", "Cancel a share"],
    ["chat.discuss", "Discuss in chat"],
    ["attach", "Attach a photo or file"],
    ["attach.preview", "Preview an attachment"],
    ["attach.remove", "Remove an attachment"],
    ["chat.msg.thing-link", "Open a thing from chat"],
    ["chat.msg.answer-line", "An answer line in chat"],
  ]),
  ...group("control", "Menu", [
    ["menu.open", "Open the menu", { added: "2026-11-03" }],
    ["menu.tile.usage", "Menu: Usage tile", { added: "2026-11-04" }],
    ["menu.row.floor", "Menu: Floor", { added: "2026-11-03", removed: "2026-11-12" }],
    ["menu.row.asks", "Menu: Home", { added: "2026-11-12" }],
    ["menu.row.usage", "Menu: Usage", { added: "2026-11-03" }],
    ["menu.row.code", "Menu: Code", { added: "2026-11-12" }],
    ["menu.row.machines", "Menu: Machines", { added: "2026-11-03" }],
    ["menu.row.mind", "Menu: Rivet's mind", { added: "2026-11-03" }],
    ["menu.row.what-you-used", "Menu: What you used", { added: "2026-11-03" }],
    ["menu.row.home", "Menu: Home Assistant", { added: "2026-11-03" }],
    ["menu.row.media", "Menu: Media", { added: "2026-11-03" }],
    ["menu.row.settings", "Menu: Settings", { added: "2026-11-03" }],
    ["jobs.red.open", "Machines: N jobs red, opens Red jobs", { added: "2026-11-03" }],
  ]),
  ...group("control", "More", [
    ["more.row.usage", "More: Usage", { removed: "2026-11-03" }],
    ["more.row.costs", "More: Costs", { removed: "2026-11-03" }],
    ["more.row.machines", "More: Machines", { removed: "2026-11-03" }],
    ["more.row.scheduled", "More: Scheduled", { removed: "2026-11-03" }],
    ["more.row.home", "More: Home", { removed: "2026-11-03" }],
    ["more.row.media", "More: Media", { removed: "2026-11-03" }],
    ["more.row.settings", "More: Settings", { removed: "2026-11-03" }],
    ["more.row.what-you-used", "More: What you used", { removed: "2026-11-03" }],
  ]),
  ...group("control", "Rivet's mind", [
    ["mind.search", "Search Rivet's mind", { added: "2026-11-03" }],
    ["mind.today", "Today on Rivet's mind", { added: "2026-11-03" }],
    ["mind.loaded", "Loaded now on Rivet's mind", { added: "2026-11-03" }],
    ["mind.type.feedback", "Rivet's mind: feedback", { added: "2026-11-03" }],
    ["mind.type.project", "Rivet's mind: projects", { added: "2026-11-03" }],
    ["mind.type.reference", "Rivet's mind: references", { added: "2026-11-03" }],
    ["mind.type.user", "Rivet's mind: user", { added: "2026-11-03" }],
    ["mind.type.decision", "Rivet's mind: decisions", { added: "2026-11-03" }],
    ["mind.zoom-in", "Zoom in on Rivet's mind", { added: "2026-11-03" }],
    ["mind.zoom-out", "Zoom out on Rivet's mind", { added: "2026-11-03" }],
    ["mind.fit", "Fit Rivet's mind", { added: "2026-11-03" }],
    ["mind.close", "Close a dot on Rivet's mind", { added: "2026-11-03" }],
    ["mind.read-all", "Read all on Rivet's mind", { added: "2026-11-03" }],
    ["mind.link", "Follow a link on Rivet's mind", { added: "2026-11-03" }],
    ["mind.view.map", "Map view of Rivet's mind", { added: "2026-11-04" }],
    ["mind.view.list", "List view of Rivet's mind", { added: "2026-11-04" }],
    ["mind.section", "Open a section of Rivet's mind", { added: "2026-11-04" }],
    ["mind.row", "Open a row of Rivet's mind", { added: "2026-11-04" }],
  ]),
  ...group("control", "What you used", [
    ["used.device.phone", "What you used: phone", { added: "2026-10-30" }],
    ["used.device.desktop", "What you used: computer", { added: "2026-10-30" }],
    ["used.retire", "Retire? on What you used", { added: "2026-10-30" }],
    ["used.rework", "Rework? on What you used", { added: "2026-10-30" }],
    ["used.show-all", "Show all on What you used", { added: "2026-10-30", removed: "2026-11-03" }],
    ["used.fold", "Open or close an area on What you used", { family: true, added: "2026-11-03" }],
    ["used.expand-all", "Expand or collapse all on What you used", { added: "2026-11-03" }],
    ["used.search", "Search What you used", { added: "2026-11-03" }],
  ]),
  ...group("control", "Settings", [
    ["settings.models.retry", "Retry who does what", { added: "2026-11-11" }],
    ["settings.models.monitor.model", "Who does what: Monitor model", { added: "2026-11-11" }],
    ["settings.models.monitor.effort", "Who does what: Monitor effort", { added: "2026-11-11" }],
    ["settings.models.work-chats.model", "Who does what: Work chats model", { added: "2026-11-11" }],
    ["settings.models.work-chats.effort", "Who does what: Work chats effort", { added: "2026-11-11" }],
    ["settings.models.app-look.model", "Who does what: App look model", { added: "2026-11-11" }],
    ["settings.models.app-look.effort", "Who does what: App look effort", { added: "2026-11-11" }],
    ["settings.models.review-lens.model", "Who does what: PR reviews model", { added: "2026-11-11" }],
    ["settings.models.review-lens.effort", "Who does what: PR reviews effort", { added: "2026-11-11" }],
    ["settings.models.hard-problem.model", "Who does what: Hard problems model", { added: "2026-11-11" }],
    ["settings.models.hard-problem.effort", "Who does what: Hard problems effort", { added: "2026-11-11" }],
    ["settings.models.small-jobs.model", "Who does what: Small jobs model", { added: "2026-11-11" }],
    ["settings.models.small-jobs.effort", "Who does what: Small jobs effort", { added: "2026-11-11" }],
    ["settings.models.daily-jobs.model", "Who does what: Daily jobs model", { added: "2026-11-11" }],
    ["settings.models.daily-jobs.effort", "Who does what: Daily jobs effort", { added: "2026-11-11" }],
    ["settings.models.night-jobs.model", "Who does what: Night jobs model", { added: "2026-11-11" }],
    ["settings.models.night-jobs.effort", "Who does what: Night jobs effort", { added: "2026-11-11" }],
    ["settings.voice.auto", "Voice: auto", { setup: true }],
    ["settings.voice.test", "Voice: test", { setup: true }],
    ["settings.push.on", "Push on", { setup: true }],
    ["settings.push.test", "Push test", { setup: true }],
    ["settings.push.off", "Push off", { setup: true }],
    ["settings.device.add", "Add a device", { setup: true }],
    ["settings.device.done", "Done adding a device", { setup: true }],
    ["settings.device.signout", "Sign out", { setup: true }],
    ["settings.patch-notes", "Patch notes"],
    ["patch-notes.link", "A link in Patch notes"],
  ]),
  ...group("control", "Ops", [
    ["ops.refresh", "Refresh Ops"],
    ["ops.section.fold", "Fold an Ops section", { family: true }],
    ["ops.page.more", "Ops: more"],
    ["ops.system-jobs.fold", "Fold system jobs", { removed: "2026-11-03" }],
    ["ops.prs.show-fetched", "Show fetched PRs"],
    ["ops.costs.open", "Open costs from Ops", { removed: "2026-11-03" }],
    ["ops.retired.fold", "Fold retired"],
    ["ops.apps-up.fold", "Fold apps up"],
    ["ops.timeline.repo", "Timeline: pick a repo", { family: true }],
    ["ops.timeline.day-more", "Timeline: more of a day"],
    ["ops.timeline.row", "A Timeline row"],
    ["ops.pr.row", "A PR row"],
    ["ops.run.row", "A run row"],
    ["plan.fold", "Fold the plan"],
    ["ops.status.detail", "Open a status's detail", { setup: true }],
    ["costs.more", "More costs", { removed: "2026-11-03" }],
    ["machines.trend.filter", "Machines: filter", { family: true }],
    ["ops.status.chat", "Open the chat from a status", { setup: true }],
    ["ops.status.pr", "A status's PR link", { setup: true }],
    ["ops.status.issue", "A status's issue link", { setup: true }],
    ["ops.status.github", "Open a status on GitHub", { setup: true }],
    ["ops.status.bring-back", "Bring back from a status", { setup: true }],
    ["ops.status.dismiss", "Dismiss from a status", { setup: true }],
  ]),
  ...group("control", "Plan and Coming", [
    ["plan.ask.open", "Open an ask"],
    ["plan.dismiss", "Dismiss an ask"],
    ["coming.sort.menu", "Coming: sort menu", { removed: "2026-11-02" }],
    ["coming.sort.option", "Coming: pick a sort", { family: true, removed: "2026-11-02" }],
    ...(["all", "not-started", "in-progress", "owner-ok", "done"].map((filter): Entry => [`coming.filter.${filter}`, `Coming: ${filter.replace(/-/g, " ")}`])),
    ["coming.sheet.open", "Open a Coming item"],
    ["coming.sheet.drop", "Drop a Coming item"],
    ["coming.sheet.close", "Close a Coming item"],
    ["plan.bring-back", "Bring back a dismissed ask"],
    ["coming.sheet.start", "Start a Coming item"],
    ["coming.sheet.pr", "A Coming item's PR link"],
    ["coming.sheet.chat", "Open a Coming item's chat"],
  ]),
  ...group("control", "Scheduled", [
    ["scheduled.pause", "Pause a schedule"],
    // A paused job is not red, so Red jobs never shows its Resume.
    ["scheduled.resume", "Resume a schedule", { removed: "2026-11-03" }],
    ["scheduled.run-now", "Run a schedule now"],
    ["scheduled.delete", "Delete a schedule"],
    ["scheduled.bring-back", "Bring a schedule back"],
    ["scheduled.dismiss", "Dismiss a schedule"],
    ["scheduled.confirm", "Confirm a schedule"],
  ]),
  ...group("control", "Home and Media", [
    ["media.more", "More media"],
    ["media.open", "Open media"],
    ["media.thumb", "A media thumbnail"],
  ]),
  ...group("control", "Desks and Agents", [
    ["desks.worker.open-card", "Open a worker's card"],
    ["desks.worker.open-chat", "Open a map row's chat"],
    ["desks.retry", "Try again when the map could not read the board", { added: "2026-11-10" }],
    ["desks.chat.close", "Close a map row's chat"],
    ["desks.chat.pr-link", "Open a PR from a map row's chat"],
    ["desks.rivet", "Rivet's desk"],
    ["desks.place", "A desk", { family: true, removed: "2026-11-02" }],
    ["desks.more", "More at work: N more"],
    ["desks.rest.close", "Close More at work"],
    ["desks.project", "A project's name: open its backlog", { added: "2026-11-02" }],
    ["home.button", "Press a Home button"],
    ["backlog.ask", "An ask on a backlog", { added: "2026-11-02" }],
    ["backlog.github", "A PR, or an ask's issue, on a backlog: opens GitHub", { added: "2026-11-02" }],
    ["backlog.more", "A backlog: N more", { added: "2026-11-02" }],
    ["backlog.close", "Close a backlog", { added: "2026-11-02" }],
    ["backlog.all", "A backlog: all on GitHub", { added: "2026-11-02" }],
    ["backlog.issue", "Open an issue from a backlog", { added: "2026-11-03" }],
    ["backlog.issue.back", "An issue: back to its backlog", { added: "2026-11-03" }],
    ["backlog.issue.start", "An issue: Start work", { added: "2026-11-03" }],
    ["backlog.issue.ask", "An issue: Ask Rivet", { added: "2026-11-03" }],
    ["backlog.issue.close", "An issue: Close", { added: "2026-11-03" }],
    ["backlog.issue.github", "An issue: open on GitHub", { added: "2026-11-03" }],
    ["backlog.issue.chat", "An issue: the chat on it", { added: "2026-11-03" }],
    ["paper.window", "Town paper: window", { removed: "2026-11-02" }],
    ["paper.find-more", "Find more work", { removed: "2026-11-02" }],
    ["paper.filter", "Town paper: filter", { family: true, removed: "2026-11-02" }],
    ["agents.ticket.show-at-desks", "Show at desks", { removed: "2026-11-02" }],
    ["agents.ticket.close", "Close a ticket", { removed: "2026-11-02" }],
    ["agents.ticket.backdrop", "Tap outside a ticket", { removed: "2026-11-02" }],
    ["agents.timeline.item", "An agents timeline item", { removed: "2026-11-02" }],
    ["agents.timeline.more-late", "More late items", { removed: "2026-11-02" }],
    ["agents.timeline.now", "Agents timeline: now", { removed: "2026-11-02" }],
    ["desks.rivet.chat", "Rivet's chat from his desk"],
    ["agents.ticket.link", "A link on a ticket", { removed: "2026-11-02" }],
    ["agents.ticket.send", "Send from a ticket", { removed: "2026-11-02" }],
    ["agents.timeline.stack", "A stack on the agents timeline", { removed: "2026-11-02" }],
    ["agents.timeline.earlier", "Agents timeline: earlier", { removed: "2026-11-02" }],
    ["agents.timeline.later", "Agents timeline: later", { removed: "2026-11-02" }],
    ["agents.copy-summary", "Copy Rivet's summary"],
  ]),
  ...group("control", "Sheets", [
    ["worker.close", "Close a worker"],
    ["worker.log-raw", "Raw worker log"],
    ["worker.send", "Send to a worker"],
    ["findwork.back", "Find work: back", { removed: "2026-11-02" }],
    ["findwork.yes", "Find work: yes", { removed: "2026-11-02" }],
    ["findwork.row", "Find work: a row", { removed: "2026-11-02" }],
    ["findwork.compose", "Find work: write", { removed: "2026-11-02" }],
    ["findwork.go", "Find work: go", { removed: "2026-11-02" }],
    ["findwork.compose-back", "Find work: back from writing", { removed: "2026-11-02" }],
    ["findwork.chat-link", "Find work: chat link", { removed: "2026-11-02" }],
    ["findwork.picture", "Find work: picture", { removed: "2026-11-02" }],
    ["lightbox.close", "Close the viewer"],
    ["lightbox.tools", "Viewer tools"],
    ["lightbox.action", "A viewer action"],
    ["media.player.play", "Play a video"],
    ["media.player.sound", "Video sound"],
    ["media.player.scrub", "Scrub a video"],
    ["media.player.before-after", "Before and after"],
    ["media.player.fullscreen", "Full screen"],
    ["media.player.file", "Open a file"],
    ["media.player.audio-play", "Play audio"],
    ["media.player.audio-save", "Save audio"],
    ["sheet.close", "Close a sheet"],
    ["lightbox.share", "Share from the viewer"],
    ["lightbox.download", "Download from the viewer"],
    ["media.player.still", "A screenshot on a card"],
    ["media.player.image", "A picture on a card"],
    ["media.player.clip", "A video on a card"],
    ["worker.pr-link", "Open a worker's PR"],
    ["findwork.replaced", "Find work: close replaced asks", { removed: "2026-11-02" }],
    ["findwork.github-link", "Find work: a GitHub link", { removed: "2026-11-02" }],
  ]),
];

/** The kinds of card a `card` event names; no card's id or text goes up. */
export const USAGE_CARD_KINDS = ["decision", "question", "plan", "update", "todo", "merge-ready", "other"] as const;
/** What happened to it: the board's answers, plus minimised and undone. */
export const USAGE_CARD_OUTCOMES = ["approve", "reject", "choice", "comment", "done", "seen", "dismiss", "minimise", "undo"] as const;

const CARDS: UsageId[] = USAGE_CARD_KINDS.flatMap((kind) =>
  USAGE_CARD_OUTCOMES.map((outcome): UsageId => ({ id: `card.${kind}.${outcome}`, kind: "card", label: `${outcome} a ${kind} card`, where: "Cards", added: RECORDING_START, meta: true })),
);

/** Every id the app may send. Ids are never removed: a phone on an older bundle still sends them. */
export const USAGE_IDS: readonly UsageId[] = [...SCREENS, ...CONTROLS, ...CARDS];

export const USAGE_BY_ID: ReadonlyMap<string, UsageId> = new Map(USAGE_IDS.map((entry) => [entry.id, entry]));

const ids = (kind: UsageIdKind) => USAGE_IDS.filter((entry) => entry.kind === kind).map((entry) => entry.id) as [string, ...string[]];
export const usageScreenSchema = z.enum(ids("screen"));
export const usageControlSchema = z.enum(ids("control"));
export const usageCardSchema = z.enum(ids("card"));

export const USAGE_DEVICES = ["phone", "desktop"] as const;
export type UsageDevice = (typeof USAGE_DEVICES)[number];
export const usageDeviceSchema = z.enum(USAGE_DEVICES);

/** What an event records: a screen left, a control used, a card answered, or a long view's deepest scroll. */
export const USAGE_EVENT_KINDS = ["screen", "tap", "card", "scroll"] as const;
export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

/** The largest value: ms, so about 24 days on one screen; the app clamps to it. */
export const MAX_USAGE_VALUE = 2_147_483_647;

/**
 * One event, `[t, kind, id, screen, value]`. `t` is the ms before the batch was sent (the server stamps the time, so the
 * phone's clock cannot skew it); an event older than the keep window is refused. `screen` is the screen or sheet on top.
 */
export const usageEventSchema = z
  .tuple([
    z.number().int().min(0).max(USAGE_KEEP_MS),
    z.enum(USAGE_EVENT_KINDS),
    z.string().max(64),
    usageScreenSchema,
    z.number().int().min(0).max(MAX_USAGE_VALUE),
  ])
  .refine(([, kind, id]) => idFits(kind, id), { message: "id not in the registry for its kind" });

export type UsageEvent = z.infer<typeof usageEventSchema>;

/** A tap names a control; a screen event names a screen; a scroll names a long view; a card event names its kind. */
export function idFits(kind: UsageEventKind, id: string): boolean {
  const entry = USAGE_BY_ID.get(id);
  if (!entry) return false;
  if (kind === "tap") return entry.kind === "control";
  if (kind === "card") return entry.kind === "card";
  if (kind === "scroll") return entry.scroll === true;
  return entry.kind === "screen";
}

/**
 * `POST /api/usage`: one batch from one device. A 400 means the batch can never be stored (an id this server does not
 * know): the app drops it rather than sending it again. `sentAt` is the app's clock as it sent: an event sent again
 * after a lost answer has the same `sentAt - age`, and is stored once. A page still on an older build sends none.
 */
export const usageBatchSchema = z
  .object({
    device: usageDeviceSchema,
    sentAt: z.number().int().min(0).optional(),
    events: z.array(usageEventSchema).min(1).max(MAX_USAGE_EVENTS),
  })
  .strict();

export type UsageBatch = z.infer<typeof usageBatchSchema>;

/** `GET /api/usage/summary?days=30&device=phone`. */
export const usageSummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(USAGE_KEEP_DAYS).default(30),
  device: usageDeviceSchema.default("phone"),
});

/** One id's use in the window: how often, when last, and for screens the median ms on it. */
export interface UsageCount {
  kind: UsageEventKind;
  id: string;
  count: number;
  /** ISO time of the latest use. */
  last: string;
  /** Screens and cards: the median value in ms. Scrolls: the median depth in %. */
  median?: number;
}

export interface UsageSummary {
  days: number;
  device: UsageDevice;
  /** ISO time of the first event kept for this device, or null when there is none yet. */
  since: string | null;
  counts: UsageCount[];
}

// What you used: the page, the Monday line in the Morning card (phone shown first), and at most 3 Retire? cards a week.

/** The window the page reads, and the days of recording before anything is called never used. */
export const USAGE_WINDOW_DAYS = 30;
/** The first Monday the weekly pass may send Retire? cards. */
export const RETIRE_CARDS_FROM = "2026-11-30";
export const RETIRE_CARDS_A_WEEK = 3;
/** An id asked about (and kept, for Keep) is off Retire? for this long. */
export const USAGE_ASK_HIDES_DAYS = 90;
/** Rework?: a screen left in under REWORK_QUICK_MS with no tap inside at least REWORK_MIN_TIMES times, half its visits or more. */
export const REWORK_QUICK_MS = 3000;
export const REWORK_MIN_TIMES = 3;
/** Rework?: an action undone within REWORK_UNDO_MS in REWORK_UNDO_SHARE of its uses or more, over REWORK_MIN_TIMES uses. */
export const REWORK_UNDO_MS = 5000;
export const REWORK_UNDO_SHARE = 0.3;
/** The controls that undo the action before them. */
export const UNDO_IDS: ReadonlySet<string> = new Set(["toast.undo", "cards.undo", "cards.key.undo"]);

/** Every feature What you used lists: the controls and screens, never bookkeeping, the signed-out sign-in or one the app no longer shows. */
export const LISTED_IDS: readonly UsageId[] = USAGE_IDS.filter((entry) => entry.kind !== "card" && !entry.meta && !entry.signedOut && !entry.removed);

/** `GET /api/usage/report?device=phone`. */
export const usageReportQuerySchema = z.object({ device: usageDeviceSchema.default("phone") });

export const USAGE_ASKS = ["retire", "rework"] as const;
export type UsageAsk = (typeof USAGE_ASKS)[number];

/** `POST /api/usage/ask`: Retire? or Rework? tapped on the page, for the id on the device the page shows. */
export const usageAskSchema = z
  .object({ id: z.string().max(64), ask: z.enum(USAGE_ASKS), device: usageDeviceSchema })
  .strict();

/** Why an id reads Rework?: its quick visits, or its undos. */
export interface UsageRework {
  opens?: number;
  quick?: number;
  uses?: number;
  undone?: number;
}

export interface UsageRow {
  id: string;
  label: string;
  where: string;
  count: number;
  /** Uses a day over the days in the window, rounded; absent under one a day. */
  perDay?: number;
  /** The day (YYYY-MM-DD) it was last used. */
  last?: string;
  rework?: UsageRework;
  /** A card already asked about it in the last 90 days: "kept" once you said Keep. */
  asked?: "asked" | "kept";
}

export interface UsageReport {
  device: UsageDevice;
  /** The day recording began, or null when nothing is recorded yet. */
  since: string | null;
  /** Full days recorded since then. */
  recorded: number;
  /** The days the window covers: the recorded days, up to 30. */
  days: number;
  taps: number;
  /** Screens opened: each a visit, counted in the Screens rows, never a tap. */
  opened: number;
  /** Days in the window with any use on this device. */
  daysUsed: number;
  often: UsageRow[];
  rarely: UsageRow[];
  /** Not used on the phone or the computer in 30 days; null before 30 full days of recording. */
  never: UsageRow[] | null;
  /** Every feature the folds list (FOLD_IDS, registry order); empty before anything is recorded. */
  features: UsageFeature[];
}

/** The Rework? numbers in words: "left in under 3 s 4 of 5 times", "undone within 5 s 3 of 8 times". */
export function reworkWords(rework: UsageRework): string {
  return [
    ...(rework.quick !== undefined ? [`left in under ${REWORK_QUICK_MS / 1000}\u00a0s ${rework.quick} of ${rework.opens} times`] : []),
    ...(rework.undone !== undefined ? [`undone within ${REWORK_UNDO_MS / 1000}\u00a0s ${rework.undone} of ${rework.uses} times`] : []),
  ].join(", ");
}

// What you used's folds: every id sits in one area, and every feature the page lists is one row in its area's fold.

export const USAGE_AREAS = [
  "Floor",
  "Decide",
  "Cards",
  "Chat",
  "Search",
  "More",
  "Settings",
  "Ops",
  "Plan and Coming",
  "Scheduled",
  "Home and Media",
  "Desks and Agents",
  "Sheets",
  "Computer shell",
  "Anywhere",
  "Removed",
] as const;
export type UsageArea = (typeof USAGE_AREAS)[number];

/**
 * The one grouping table: a control or card goes by its registry group (`where`), a screen by its id. An id the app no
 * longer shows (`removed`) goes to Removed whatever its area was (usage-areas.test.ts: every id lands in exactly one).
 */
export const AREA_TABLE: Record<Exclude<UsageArea, "Removed">, { where: readonly string[]; screens: readonly string[] }> = {
  Floor: { where: ["Floor", "Menu"], screens: ["floor", "floor.list", "floor.page", "menu", "floor.rivet", "readings", "progress", "tab.via-link", "briefing.past"] },
  Decide: { where: ["Decide sheet", "Answered"], screens: ["decide", "decide.via-push", "decide.via-link", "answered"] },
  Cards: { where: ["Cards", "Updates"], screens: ["cards", "updates.thread", "reject"] },
  Chat: { where: ["Chat"], screens: ["chat", "chat.thing"] },
  Search: { where: ["Search"], screens: ["search"] },
  More: { where: ["More", "What you used"], screens: ["more", "more.what-you-used"] },
  Settings: { where: ["Settings", "Sign-in"], screens: ["more.settings", "patch-notes", "gate"] },
  Ops: { where: ["Ops", "Rivet's mind"], screens: ["more.usage", "more.costs", "more.mind", "more.machines", "ops.code", "ops.timeline", "ops.status"] },
  "Plan and Coming": { where: ["Plan and Coming"], screens: ["coming.sheet"] },
  Scheduled: { where: ["Scheduled"], screens: ["more.scheduled", "scheduled.ask", "jobs.red"] },
  "Home and Media": { where: ["Home and Media"], screens: ["more.home", "more.media"] },
  "Desks and Agents": { where: ["Desks and Agents"], screens: ["desks.rest", "desks.chat", "desks.backlog"] },
  Sheets: { where: ["Sheets"], screens: ["worker", "share", "stop-confirm", "rivet-summary", "findwork", "ticket"] },
  "Computer shell": { where: ["Computer shell"], screens: ["shortcuts"] },
  Anywhere: { where: ["Anywhere"], screens: ["unknown"] },
};

/** Every area the table gives an id, ignoring `removed`: exactly one for each id. */
export function areaMatches(entry: Pick<UsageId, "id" | "kind" | "where">): UsageArea[] {
  return (Object.keys(AREA_TABLE) as Exclude<UsageArea, "Removed">[]).filter((area) =>
    entry.kind === "screen" ? AREA_TABLE[area].screens.includes(entry.id) : AREA_TABLE[area].where.includes(entry.where),
  );
}

/** The fold an id sits in. */
export function usageArea(entry: UsageId): UsageArea {
  return entry.removed ? "Removed" : (areaMatches(entry)[0] ?? "Anywhere");
}

/** The features the folds list: What you used's own, and the ones the app no longer shows. */
export const FOLD_IDS: readonly UsageId[] = USAGE_IDS.filter((entry) => entry.kind !== "card" && !entry.meta && !entry.signedOut);

/** Used a lot: this many uses (taps, or screens opened) on this many days or more, both devices together (the 2 Nov review). */
export const USAGE_LOT_TIMES = 10;
export const USAGE_LOT_DAYS = 4;

/** A lot, sometimes, untouched in the window, can't tell (untouched, but a `setup` id), or removed from the app. */
export const USAGE_STATUSES = ["lot", "some", "untouched", "unclear", "removed"] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

/** One feature in its fold: both devices' counts in the window, and the page's device's Retire? or Rework?. */
export interface UsageFeature {
  id: string;
  label: string;
  area: UsageArea;
  phone: number;
  desktop: number;
  /** Days in the window it was used on, either device. */
  days: number;
  /** The day (YYYY-MM-DD) it was last used, either device. */
  last?: string;
  status: UsageStatus;
  /** The day the app stopped showing it. */
  removed?: string;
  /** In `never`: Retire? may be asked. */
  retire?: true;
  rework?: UsageRework;
  asked?: "asked" | "kept";
}

export function usageStatus(entry: Pick<UsageId, "removed" | "setup">, uses: number, days: number): UsageStatus {
  if (entry.removed) return "removed";
  if (uses >= USAGE_LOT_TIMES && days >= USAGE_LOT_DAYS) return "lot";
  if (uses > 0) return "some";
  return entry.setup ? "unclear" : "untouched";
}
