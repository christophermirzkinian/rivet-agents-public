// Whether a PR is held by a line in its body or comments, as the bridge's merge from a
// card and the Ops page read it. Over-matching only keeps a PR off a merge.
//
// A hold line is any line, anywhere in the body or a comment, that opens with
// "hold" / "do not merge", puts a PR, merge or deploy "on hold", or names a
// hold: "**Owner hold:** …", "Merge hold from the monitor …", "- Hold: …",
// "Holds: no merge before …". "Holds: none", "no owner hold", "owner hold
// released", prose about PRs "on hold", an approval sent "before merge" and
// another PR's "(PR 96, do not merge)" are not holds. Text never
// releases a hold by containing the words ("That releases the owner hold",
// "Hold released? No"): a body hold ends when its line is edited out of the
// body, and a comment hold when its line is edited out or a later owner
// comment opens with an explicit release line ("Hold released", "Unhold",
// "Release hold" or "Lift hold", alone or followed by ": <why>", read by
// `currentTexts`). A Rivet yes releases nothing by itself: what a yes means
// depends on the card's question.
// Agents and the owner post as the same login, so either one is the owner's word
// only as far as the login is.
//
// Text that only names a hold is not one: the "Item:" and "Asked:" lines of a
// Rivet owner-decision record, which quote the card's question; a quoted hold
// a release lifts ("His yes also lifts the "do not merge" note"), as that hold
// is read where it lives; and a file name ("holds-file.mjs").

// Lines are matched with Markdown emphasis and code marks (*, _, `) taken out,
// so "On **hold**", "Do **not** merge", "_Hold_" and "`hold`" read as plain words,
// and again with only paired marks taken out, so a footnote mark is kept:
// "No owner hold*." over "* Only after the owner approves." holds. Either reading holds.
const EMPHASIS = /[*_`]+/g;
/**
 * The line with paired marks taken out and any other mark kept, in one linear pass. A run of
 * one mark (*, _ or `) opens away from a word (not after a word character or a backslash, and
 * before a non-space) and closes the innermost open runs of that mark it covers whole (after a
 * non-space other than a backslash, and not before a word character), so "*No **owner hold***."
 * pairs all three; a backtick run opens anywhere and closes the nearest run of its own length,
 * as a code span's edge does; the runs opened inside a pair close with it. An escaped run
 * neither opens nor closes. "hold*. See *notes*" keeps its footnote mark, "\*No owner hold*.",
 * "`*No owner hold`*." and "`*`No owner hold*." keep their last star, and "**No _owner hold_.**"
 * loses all four runs.
 * @param {string} line
 */
export function unpaired(line) {
  const runs = [...line.matchAll(/\*+|_+|`+/g)];
  /** Open runs, innermost last; only the newest 64 are ever closed, so the pass stays linear. @type {{ i: number, mark: string, size: number }[]} */
  let open = [];
  const cut = runs.map(() => 0);
  for (const [i, run] of runs.entries()) {
    const at = run.index ?? 0;
    const before = line[at - 1] ?? "";
    const after = line[at + run[0].length] ?? "";
    if (before === "\\") continue;
    const mark = run[0][0];
    const code = mark === "`";
    let left = run[0].length;
    if (code || (/[^\s\\]/.test(before) && !/\w/.test(after))) {
      for (let k = open.length - 1; k >= 0 && left > 0; k -= 1) {
        const o = open[k];
        if (o.mark !== mark || (code && o.size !== left)) continue;
        if (o.size > left) break;
        cut[o.i] = o.size;
        cut[i] += o.size;
        left -= o.size;
        open = open.slice(0, k);
        if (code) break;
      }
    }
    if (left === run[0].length && (code || (!/[\w\\]/.test(before) && /\S/.test(after)))) open = [...open, { i, mark, size: left }].slice(-64);
  }
  let out = "";
  let at = 0;
  for (const [i, run] of runs.entries()) {
    if (!cut[i]) continue;
    out += line.slice(at, run.index) + run[0].slice(cut[i]);
    at = (run.index ?? 0) + run[0].length;
  }
  return out + line.slice(at);
}
/** @param {string} line */
const readings = (line) => [line.replace(EMPHASIS, ""), unpaired(line)];
// "hold" as a word: not "holding" or the hold-safe.mjs check.
const H = "(?<![a-z])hold(?![a-z(]|-safe|\\s+check)";
// Where a bare "hold" may open: a line past its list marker or quote ("- ",
// "> ", "- [ ]", "1)"), or a clause after punctuation, and a joining word.
const OPEN = "(?:^(?:[\\s>#+-]|\\[[ x]\\]|\\d+[.)])*|[;:,.!?]\\s+|[\u2014\u2013]\\s*)(?:(?:but|and|then|so|please|still)\\s+)*";
// A plural label: "Owner holds: …", "Holds — …"; not "thresholds:" or the file name "holds-file.mjs".
const HOLDS = "(?<![a-z])holds\\s*(?:[:|\u2014\u2013]|-(?![\\w.]))";
// Exclude the verb in a decision citation or invariant statement, not arbitrary
// label prefixes: "Remaining holds:" and other plural labels must still block.
// Remove only that verb; a separate real hold later in the line remains visible.
const PROSE_HOLDS = /\b(the\s+(?:\d{4}-\d{2}-\d{2}\s+)?decision(?:\s+\(#\d+\))?|the\s+invariant)\s+holds(?=\s*:)/gi;
// "hold:" as a verb, not a label: a short noun phrase that opens its line or list item, then a plural
// noun of a closed set ("rules", "invariants", "constraints", "guarantees", "properties", "assumptions"): "- Queue's
// retry-safe and single-writer rules hold: the worker owns the row" is no hold. The phrase is two to four
// words: compounds ("single-writer", "Queue's") or "and", "or", "both", "all", "the", "these", "those", "our", "its",
// "their", ending on a compound; no part of a compound may merge, block, hold, wait, condition, approve, need or deny.
// Anything else before the noun is a label or an instruction and holds: "The owner hold:", "Status of the rules hold:",
// "We should still hold:", "Awaiting confirmation the invariants hold:", "Blocked until all queue invariants hold:",
// a list mark or a task box inside the phrase, or any longer clause. Read after "hold" is matched, so the look back runs
// only there.
const HOLD_WORD =
  "(?:merg(?:e|es|ed|ing)|block(?:s|ed|ing)?|freez(?:e|es|ing)|frozen|park(?:s|ed|ing)?|drafts?|embargo(?:es|ed)?|moratori(?:um|ums|a)|lock(?:s|ed)?|paus(?:e|es|ed)|halt(?:s|ed)?|holds?|held|holding|stop(?:s|ped)?|a?wait(?:s|ed|ing)?|until|till|unless|before|after|once|when|whenever|if|pending|without|needs?|needed|requires?|required|proof|prove|ensure|confirm(?:s|ed|ation)?|verify|check|make|approv(?:e|es|ed|al)|sign|ok|okay|go|owner|monitor|user|video|playtest|only|not|never|no|cannot|(?:can|don|doesn|didn|isn|aren|wasn|weren|won|wouldn|shouldn|couldn|hasn|haven|hadn|mustn|needn)['\u2019]t|must|should)(?![a-z0-9])";
const PART = `(?!${HOLD_WORD})[a-z0-9]+`;
const COMPOUND = `${PART}(?:(?:-${PART})+(?:['\u2019]s)?|['\u2019]s)`;
const CONNECTOR = "(?:and|or|both|all|the|these|those|our|its|their)";
const VERB_SUBJECT = "(?:rules|invariants|constraints|guarantees|properties|assumptions)";
const VERB_CLAUSE = `^[ \\t]*(?:>[ \\t]*)*(?:(?:[-*+]|\\d{1,3}[.)])[ \\t]+)?(?:(?:${COMPOUND}|${CONNECTOR})[ \\t]+){1,3}${COMPOUND}[ \\t]+${VERB_SUBJECT}[ \\t]+hold`;
// What follows the colon may not hold either: "The release-freeze rules hold: this PR stays parked" and "… hold: leave
// it unmerged" are holds. Word stems match inside words ("unmerged"), so the claim after the colon must be plain, and on
// the colon's own line: a colon that ends its line leads into a list and stays a label.
const HOLD_AFTER = "(?=\\s*:[^a-z0-9\\n]*(?:\\n|$)|\\s*:[^\\n]*(?:merg|block|freez|froz|park|draft|embargo|morator|hold|held|wait|until|unless|pending|approv|sign|owner|leave|keep|stay|ship|deploy|releas|land|lock|paus|halt|suspen|defer|postpon|delay|remain|avoid|stop|skip|veto|object|reject|refus|disput|contest|maintainer|review|must|should|shall|ought|need|requir|cannot|through|tomorrow|today|tonight|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|n['\u2019]t|(?<![a-z0-9])(?:pr|prs|not|never|nothing|nobody|no[ \\t]+one|this|it|go|ok|okay|yes|ha(?:s|ve|d)[ \\t]+to|may|do)(?![a-z0-9])))";
const NOT_VERB = `(?:(?<!${VERB_CLAUSE})|${HOLD_AFTER})`;
// A line opens its clause only when the last line with text before it is a heading or ends a sentence (".", "!", "?"),
// and no lead-in ending in a colon governs it. A lead-in in plain prose, or one with a merge, condition or person word,
// governs the rest of its section (sub-sections included, up to the next heading of its level or higher; to the end
// without one), and so does a heading with such a word ("## Merge blocked pending proof") or a prose line that merges,
// blocks, waits or conditions ("This PR is blocked until the checks below pass."); a list item's other lead-in governs only its own sub-items ("- The engine books each placement using
// these answers:\n  - …\n- Queue's single-writer rules hold: …" is free, #668). So "This PR is blocked until\n- all
// queue invariants hold:", "Blocked until:\n\n- all …" and "## Merge conditions\nBlocked until:\n### Queue\n-
// all …" hold.
const VERB_HOLD = new RegExp(`(?<=${VERB_CLAUSE})(?!${HOLD_AFTER})\\s*:`, "i");
const BLOCK_WORD = /(?<![a-z0-9])(?:merg(?:e|es|ed|ing)|block(?:s|ed|ing)?|until|till|unless|pending|a?wait(?:s|ed|ing)?|prerequisites?|depends?)(?![a-z0-9])/i;
const LEAD_WORD = new RegExp(`(?<![a-z0-9])(?:${HOLD_WORD}|condition[a-z]*|prerequisite[a-z]*|depend[a-z]*|gat(?:e|es|ed|ing)|blockers?)(?![a-z0-9])`, "i");
const HEADING = /^[\s>#*+-]*(?:(?:owner|user|merge|deploy|monitor)\s+)?(?:holds?|held)[ \t]*(?::[ \t]*)?$/i;
const NONE = /^[\s>#*+-]*(?:none|no\s+(?:(?:owner|user|merge|deploy|monitor)\s+)?holds?|n\/a)[ \t]*(?:\.[ \t]*)?$/i;
// A hold or wait on the owner, his card, video or word, whatever word holds it: "Merge held for the owner", "Held
// pending the owner's approval", "Holding for the owner's video OK", "Draft until the owner approves", "has been held for
// The owner", "awaiting the owner", "waits on the owner's OK"; not "Deploy after merge waits for …". The past tells how a hold ended
// ("was held for the owner", "had been held …"), so an "## Approval" note is none, nor is a denial ("Nothing is waiting on
// the owner", "not held for the owner"). "On" and "by" take a person, so a note's "held on the card" is no hold. A denial that
// goes on ("not held for the owner but for the owner", "Nothing waits on the owner except this PR") holds, failing safe, whenever the
// rest of its sentence names a person, his OK or video, this PR or "it", or a wait or hold word, so "… but this change
// is waiting on CI" holds too; it is free only when the rest names none ("Nothing is waiting on the owner, but CI is
// still running"); a colon does not end the sentence ("except for one item: this PR"). asks.mjs reads the same words
// as an ask awaiting the owner.
const PERSON = "(?:owners?|monitor)";
const THING = "(?:video|card|approval|ok|word|go-ahead|sign[- ]?off|yes)";
const OF = "(?:(?:the|his|her|their|an?|final|last|full|explicit|written|formal|[a-z]+['\u2019]s|[a-z]+s['\u2019])\\s+){0,3}";
const FILLER = "(?:\\s+[a-z#0-9'\u2019-]+){0,3}?";
const DENIED = "(?:nothing|nobody|no\\s+one|not|never|no\\s+longer|n['\u2019]t)(?:\\s+(?:is|are|still|now))?\\s+";
const UNTIL = "(?:for|until|till|pending)(?:\\s+after)?";
// What a hold or wait is about when it is not the line's or clause's opening word: this PR or the merge.
const SUBJECT = "(?:(?:this|the)\\s+(?:pr|pull\\s+request|branch|change|merge|deploy)|(?:pr|pull\\s+request)\\s*#?\\d+|merge|merging|deploy)";
const AUX = "(?:\\s+(?:is|are|am|stays|remains|still|now|also|only|has\\s+been))*";
// A wait word holds only where it opens its line or clause, or follows this PR, the merge or "it": "Green,
// awaiting the owner", "This PR waits on the owner's OK"; not another job's wait in prose ("showed that job as
// waiting for a review slot", "the real run waits for the monitor's OK on the dry-run counts").
const WAIT_AT = `(?<=(?:^|\\n|[;:,.!?(|\u2014\u2013])[\\s>#*_\`+-]*(?:\\[[ x]\\]\\s*)?(?:\\d+[.)]\\s*)?(?:(?:but|and|then|so|please|still|now|also|only)\\s+)*(?:(?:${SUBJECT}|it|we|i)${AUX}\\s+)?)`;
export const HELD_ON =
  "(?<![a-z])(?<!(?:was|were|had\\s+been)\\s+(?:(?:a|an|still|kept|left)\\s+)?)(?:" +
  `(?<!${DENIED})(?:(?:(?:held|holding|on\\s+hold|hold|draft)${FILLER}\\s+${UNTIL}|${WAIT_AT}(?<!after\\s+merg(?:e|es|ing)\\s+)(?:a?wait(?:s|ing)?|awaits)\\s+(?:only\\s+)?(?:on|${UNTIL})|${WAIT_AT}(?:awaiting|awaits))\\s+${OF}(?:${PERSON}|${THING})` +
  `|(?:held|holding|on\\s+hold)${FILLER}\\s+(?:on|by)\\s+(?:the\\s+)?${PERSON})` +
  `|[a-z]*${DENIED}(?:held|holding|on\\s+hold|a?wait(?:s|ing)?|awaits|awaiting)(?:[^.;:!?\\n]|\\n(?![ \\t]*\\n)){0,80}?\\s(?:but|except|save|only|other\\s+than|apart\\s+from)(?![a-z])(?:[^.;!?\\n]|\\n(?![ \\t]*\\n)){0,120}?(?<![a-z])(?:${PERSON}|${THING}|this\\s+(?:pr|pull\\s+request|one|change|branch|merge)|it|held|holding|hold|blocked|draft|a?wait(?:s|ing)?|awaits|awaiting)` +
  ")(?![a-z])";
const HELD_ON_RE = new RegExp(HELD_ON, "i");
const HELD_ON_ALL = new RegExp(HELD_ON, "gi");
// A hold on the owner opening this line, read after the line it soft-wraps from, so "Merge was\nheld for the owner" is past and
// "Nothing is\nwaiting on the owner" a denial. One that opens on the line before is the cross-line pass's.
function heldOnHere(line, before) {
  const lead = before === null ? "" : `${before}\n`;
  return [...`${lead}${line.replace(/^[ \t]*(?:>[ \t]*)+/, "")}`.matchAll(HELD_ON_ALL)].some((m) => m.index >= lead.length);
}
const MERGE_APPROVAL = /(?<![a-z])merg(?:e|es|ing)?(?:\s+(?:and|or)\s+deploy)?\s+(?:only\s+)?(?:on|after)\s+(?:[a-z]+\s+){0,3}?[a-z]+(?:['\u2019]s|s['\u2019])?\s+(?:word|ok|go|approval|approves|yes)(?![a-z])/i;
// An approval still required before merge, soft wraps included: "Require owner approval before merge", "The owner's OK
// before merge is mandatory". A denied one ("We no longer require …") still holds, since an exception may follow it.
const REQUIRED = new RegExp(
  `(?<![a-z])(?:requires?|required|needs?|must\\s+(?:have|get|wait\\s+for))\\s+(?:[a-z'\u2019]+\\s+){0,4}?${THING}\\s+(?:[a-z'\u2019#0-9]+\\s+){0,3}?before\\s+merg` +
    `|(?<![a-z])${THING}\\s+before\\s+merg(?:e|ing)\\s+(?:is|stays|remains)\\s+(?:required|mandatory|needed|a\\s+must)(?![a-z])`,
  "i",
);
// Hold phrases of more than one word, read again across soft wraps (WRAPPED_HOLD).
const ON_HOLD = `(?<![a-z])${SUBJECT}${AUX}\\s+on\\s+${H}`;
const HOLD_UNTIL = `${H}(?:\\s+[a-z#0-9]+){0,3}?\\s+until(?![a-z])`;
const DO_NOT_MERGE = `(?<![a-z])do(?:\\s+not|\\s*n['\u2019]?t)\\s+merge(?![a-z])`;
const NO_MERGE = `(?<![a-z])no\\s+merge(?:\\s+or\\s+deploy)?(?:\\s+(?:until|before|without)(?![a-z])|[ \\t]*(?=$|[.;,)]))`;
const MERGE_HELD = `(?<![a-z])(?:merge\\s+held\\s+until|held\\s+until\\s+(?:#\\d|the\\s+(?:owner|monitor)))(?![a-z])`;
const MERGE_WAITS = `(?<![a-z])(?<!after\\s+)merg(?:e|es|ing)\\s+waits?\\s+(?:only\\s+)?(?:on|for)(?![a-z])`;
const NOTHING_MERGES = `(?<![a-z])(?:nothing|not)\\s+merg(?:e|es|ed|ing)?\\s+(?:before|until|without)(?![a-z])`;
const BLOCKED = `(?<![a-z])this\\s+pr\\s+(?:must\\s+remain|remains)\\s+blocked(?![a-z])`;
const HOLD_LINE = new RegExp(
  [
    `${OPEN}(?:on\\s+)?${H}`,
    ON_HOLD,
    HOLD_UNTIL,
    `${H}\\s+off(?![a-z])`,
    // A footnote mark on "hold" ("No hold*." over "* Only after …"), kept only by the paired reading.
    `(?<![a-z])holds?\\*`,
    `(?<!(?:these|they|must)\\s+)${H}${NOT_VERB}\\s*:`,
    `^[\\s>#+-]*(?:(?:owner|user|merge|deploy|monitor)\\s+)?holds?\\s*$`,
    HOLDS,
    `(?<![a-z])(?:owner|user|merge|deploy|monitor|main)(?:\\/monitor|-[a-z]+)?[\\s-]+(?:${H}|${HOLDS}|holds\\s+(?:may|must|stay|remain|until)(?![a-z]))`,
    DO_NOT_MERGE,
    // An explicit blocked-PR status still holds beside a contradictory "No owner hold".
    BLOCKED,
    // A merge that waits on someone's word, not on the hold vocabulary:
    // "no merge until …", "merge held until #379", "Merging waits on …",
    // "Merge only on the monitor's word", "Nothing merges before his OK"; not "Deploy after merge waits for …". An ask sent
    // "before merge" ("went to the owner for an OK before merge") tells what was done, not that it is still waited on
    //; a wait on it is written as one ("Waiting on the owner's OK").
    NO_MERGE,
    // An approval still required before merge is a hold: "Require owner approval before merge", "The owner's OK before merge
    // is mandatory".
    REQUIRED.source,
    MERGE_HELD,
    // A "Held:" label opening its line or clause, not "His condition held: …".
    `${OPEN}held\\s*:`,
    MERGE_WAITS,
    NOTHING_MERGES,
    MERGE_APPROVAL.source,
  ].join("|"),
  "i",
);
// The same phrases with their spaces read across a soft wrap, never a blank line: "Do not\nmerge until I approve".
const WRAPPED_HOLD = new RegExp(
  [ON_HOLD, HOLD_UNTIL, DO_NOT_MERGE, NO_MERGE, MERGE_HELD, MERGE_WAITS, NOTHING_MERGES, BLOCKED].map((p) => p.replaceAll("\\s", "[^\\S\\n]")).join("|"),
  "i",
);
// Phrases that say there is no hold. Each is cut out of the line before it is
// matched, so "no deploy hold; Hold: waiting on the video" still holds. Each
// counts only when it ends its clause: "Hold: none of this merges" and "No owner
// hold may be released yet" hold.
// A status list may go on after a comma ("no owner hold, all findings triaged"),
// unless the next words qualify it ("No owner hold, even after CI, may …",
// "No owner hold—without exception—may …", "none, only after the owner approves").
const END =
  "(?:[ \\t]+(?:on|for)[ \\t]+this[ \\t]+pr)?[ \\t]*(?=$|[.;)|]|\\](?=[ \\t]*(?:[.;][ \\t]*)?$)|[,\u2014\u2013](?![ \\t]*(?:$|\\())(?![ \\t]*(?:even|including|except|until|unless|no[ \\t]+matter|regardless|without|whatever|however|may|must|can|will|shall|is|are|only(?:[ \\t]+(?:after|once|when|if|on|with|until|upon)|[ \\t]*$)|once|after|before|pending|when|if)(?![a-z])))";
// "Hold released" as a status, cut out by `cutReleased` only when nothing in the rest of its paragraph can condition
// it (RELEASED_IF, Markdown marks taken out), failing closed: not "Hold released only after …", "Hold released:
// agreed,\nbut only after …", "Hold released.\nProvided the owner approves." or a wrapped "- [ ] only after …" item. A
// paragraph left open (no full stop) runs on into a next one that opens in lower case ("Hold released\n\nonly after …").
// A next paragraph that opens with a condition word keeps it too ("Hold released.\n\nOnly after …").
// "Owner hold released" is also kept when the rest of its sentence, soft wraps included, has a word that can
// deny or condition it (RELEASE_GUARD) or it is a question: "Owner hold released? No; #620 is pending".
const RELEASED = /(?:^[ \t>#*_+-]*|[;:.!?\u2014\u2013][ \t]*)((?:owner|user|merge|deploy|monitor)[ \t]+)?holds?[ \t]+(?:released|lifted)(?![a-z])/gim;
const RELEASED_IF =
  /(?:(?<![a-z])(?:only|once|after|when|whenever|if|until|till|unless|upon|pending|subject|provided|providing|condition|conditional|conditionally|but|except|before|not|never|yet|wait|waits|waiting|await|awaits|awaiting|(?:as|so)[\s>]+long[\s>]+as|in[\s>]+case)|n['\u2019]t)(?![a-z])/i;
// A paragraph's end: a blank line, quoted or not.
const PARAGRAPH_END = /\n[ \t]*(?:>[ \t]*)*(?:\n|$)/;
// A blank line, quoted or not, without the text's end: a read window's cut end is not a paragraph's end.
const BLANK_LINE = /\n[ \t]*(?:>[ \t]*)*\n/;
// A bracketed aside after "none" that is only a note of an approval, read whole (APPROVAL_ASIDE): "Owner holds: none
// (the owner approved the plan)", a checkpoint line that would otherwise block its merge. Any other aside
// ("The owner approved pausing this PR", "approval is void", "stop this PR", "until the owner approves") keeps the line a hold.
// src/shared/pr-holds.ts mirrors it; a test keeps them in step.
export const APPROVAL_ASIDE = /(?:(?:the[ \t]+)?owners?[ \t]+)?(?:(?:has|have)[ \t]+)?(?:approved|oked|ok['\u2019]?d|okayed|signed[ \t]+off(?:[ \t]+on)?|agreed(?:[ \t]+to)?|gave[ \t]+(?:it[ \t]+)?the[ \t]+go-ahead(?:[ \t]+(?:for|on))?)(?:[ \t]+(?:(?:the|this|his|her|that)[ \t]+)?(?:plan|pr|change|changes|video|build|design|approach|fix|it|this))?[ \t]*\.?/i;
const NONE_ASIDE = `(?:[ \\t]*\\(${APPROVAL_ASIDE.source}\\))?`;
const NOT_A_HOLD = new RegExp(
  [
    `(?<![a-z])no\\s+(?:(?:owner|user|merge|deploy|monitor)\\s+)?holds?${END}`,
    // "Holds: none", and "Holds: none from the owner".
    `(?<![a-z])holds?[\\s:|\u2014\u2013]*(?:none|no)(?:\\s+(?:from|by|on|for)\\s+(?:the\\s+)?${PERSON})?${NONE_ASIDE}${END}`,
  ].join("|"),
  "gi",
);
// A quoted hold named as what an owner's answer lifts ("His yes also lifts the "do not merge" note in the body.") names a
// hold that lives elsewhere (the body, a label, another comment), which is read there. Only a whole sentence of that one
// shape is cut out of its line before the line is read, so the rest still holds: one of a closed set of subjects ("his
// yes", "your approval", "The owner's decision"), "also" or "now", a release verb, the quoted hold, at most a noun and where
// it is, and a full stop. It opens with a capital after a full stop on its line, or opens its line after a line that
// ends a sentence or a blank line (not a soft wrap, nor a "Never do the following:" preamble). Any other word keeps the
// sentence read as written, so it holds: "Do not lift the "do not merge" note", "We cannot remove …", "Do n**ot**
// remove …", "… note only after the owner approves." Nor is it cut where a word that can deny or condition it (RELEASE_GUARD)
// stands beside it: in its block (its paragraph, or its list item with the lines wrapped into it), in the block before
// it (for a list item after another, the block before the list, and every item it is nested under), or in the block
// after it, unless both are list items and the next is not nested under it and opens with no such word: "Do not assume, e.g. His yes lifts …", "His yes lifts … note. But only after the owner
// signs off.", "Never assume any of these:" over a list, "- But only after the owner signs off." after the item.
const RELEASE_SENTENCE = new RegExp(
  "(?:(^[ \\t]*(?:>[ \\t]*)*(?:(?:[-*+]|\\d{1,3}[.)])[ \\t]+)?)|(?<=[.!?][\"'\u201d\u00bb)\\]*_`]{0,4}[ \\t]{1,4}))" +
    "(?:his|her|their|your|my|our|the|this|that|(?:the[ \\t]+)?owner['\u2019]s)[ \\t]+" +
    "(?:yes|approval|decision|answer|choice|reply|go-ahead|sign[- ]?off)(?:[ \\t]+(?:also|now))?[ \\t]+(?:has[ \\t]+)?" +
    "(?:lift(?:s|ed)|releas(?:es|ed)|clear(?:s|ed)|remov(?:es|ed))[ \\t]+the[ \\t]+" +
    "(?:\"[^\"\\n]{1,60}\"|\u201c[^\u201d\\n]{1,60}\u201d|\u00ab[^\u00bb\\n]{1,60}\u00bb)" +
    "(?:[ \\t]+(?:note|label|line|hold|comment|marker))?" +
    "(?:[ \\t]+(?:in|on|from)[ \\t]+(?:(?:the|this|that|his|her|their|your|[a-z]+['\u2019]s)[ \\t]+)?(?:pr|pull[ \\t]+request|body|description|branch))?" +
    "\\.(?=[ \\t]|$)",
  "gi",
);
const RELEASE_GUARD = /(?:(?<![a-z])(?:not|never|no|nobody|nothing|none|neither|nor|without|cannot|only|once|after|before|when|whenever|if|until|till|unless|upon|pending|wait|waits|waiting|await|awaits|awaiting|yet|later|first|soon|must|should|shall|need|needs|require|requires|provided|assume|assumes|assumed|assuming|pretend|claim|claims|false|untrue|wrong|incorrect|subject|depend|depends|depending|condition|conditional|except|but|however|keep|keeps|held|hold|holds|stay|stays|remain|remains|block|blocks|blocked|stop|lie|lies|lied|lying|doubt|doubts|reject|rejects|rejected|deny|denies|denied|refuse|refuses|refused|revoke|revokes|revoked|withdraw|withdraws|withdrew|withdrawn|retract|retracts|retracted|cancel|cancels|cancelled|canceled|overrule|overruled|veto|vetoed|invalid|void|fake|bogus|ignore|ignored|disregard)|n['\u2019]t)(?![a-z])/i;
const guarded = (text) => RELEASE_GUARD.test(text.replace(EMPHASIS, ""));
// A list item's first line, which opens a block of its own.
const LIST_ITEM = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,3}[.)])[ \t]/;
// A line that ends its sentence, so a sentence opening the next one is whole.
const SENTENCE_END = /[.!?]["'\u201d\u00bb)\]*_`]*[ \t]*$/;
// The literal first line of a comment, so a quote, an indented example or a
// second line is not a release.
const RELEASE = /^ {0,3}(?:[-*] {1,4})?[*_]*(?:unhold|release[ \t]+(?:the[ \t]+)?hold|hold[ \t]+released|lift[ \t]+(?:the[ \t]+)?hold)(?![a-z])[*_]*(?=[ \t]*(?:[.!][ \t]*)?$|[ \t]*(?:[:—–]|[ \t]-)[ \t]*\S)/i;

/**
 * A label as every hold check reads it (the merge from a card and its Ops verdict):
 * terminal escapes taken out, then everything but letters and digits, lower case. Spacing,
 * dashes, zero-width and direction marks cannot split or hide a hold label: "do-not-merge",
 * "do\tnot merge" and "do\ufeffnot merge" are all "donotmerge", and "ho\u200fld" is "hold".
 * A label is a hold when its key names a hold or equals a hold label's key.
 * @param {string} label
 */
export function labelKey(label) {
  return String(label)
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]?|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~]?)/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** @param {string} text */
const lines = (text) => text.split(/\r\n|\r|\n/);

// A Rivet owner-decision record (templates.mjs githubCommentBody): a "**Owner decision (via Rivet): …**" headline ,
// field lines up to the first blank line, and its reply marker last (a reply id as validate.mjs takes it). Its "Item:"
// and "Asked:" fields quote the card's question ("Your yes also lifts the "do not merge" note"), so they are not read;
// the headline, "Choice:" and "Choice detail:" lines and the owner's own quoted words are read as in any comment.
const RECORD_HEAD = /^\*\*Owner decision \(via Rivet\): .*\*\*$/;
const RECORD_MARK = /^<!-- rivet-reply:[\w.-]{1,100} decision=[a-z]+ -->$/;
const RECORD_QUESTION = /^(?:Item|Asked): /;

/**
 * A text's lines as written (`raw`) and as they are read for holds (`read`, line for line): a decision record's
 * question fields blanked, and each whole release sentence (RELEASE_SENTENCE) cut out.
 * @param {string} text @param {(text: string) => string[]} split
 */
function readLines(text, split = lines) {
  const raw = split(text);
  const read = [...raw];
  const fields = raw.findIndex((line) => !line.trim());
  if (fields > 0 && RECORD_HEAD.test(raw[0].trim()) && RECORD_MARK.test(raw.filter((line) => line.trim()).pop()?.trim() ?? "")) {
    for (let i = 1; i < fields; i += 1) if (RECORD_QUESTION.test(raw[i])) read[i] = "";
  }
  const cut = [...read];
  /** @type {{ lines: number[], item: boolean }[]} */
  const blocks = [];
  let block = null;
  let before = null;
  let gap = true;
  for (const [i, line] of read.entries()) {
    if (!line.trim()) {
      gap = true;
      block = null;
      continue;
    }
    // A sentence opening this line is whole after a blank line (not a "…:" preamble's) or a line that ends one.
    const opens = before === null || (gap ? !/:[ \t]*$/.test(before.replace(EMPHASIS, "")) : SENTENCE_END.test(before));
    cut[i] = line.replace(RELEASE_SENTENCE, (whole, start) => {
      if (start === undefined) return /^[A-Z]/.test(whole) ? " " : whole;
      return opens ? `${start} ` : whole;
    });
    if (!block || LIST_ITEM.test(line)) blocks.push((block = { lines: [], item: LIST_ITEM.test(line) }));
    block.lines.push(i);
    before = line;
    gap = false;
  }
  const words = blocks.map((b) => guarded(b.lines.map((i) => cut[i]).join(" ")));
  const indent = (/** @type {{ lines: number[] }} */ b) => /^[ \t>]*/.exec(read[b.lines[0]])?.[0].length ?? 0;
  let led = false;
  /** @type {{ indent: number, guard: boolean }[]} */
  let parents = [];
  for (const [k, b] of blocks.entries()) {
    const prior = blocks[k - 1];
    if (!(b.item && prior?.item)) {
      led = !!prior && words[k - 1];
      parents = [];
    }
    // A nested item reads every item it is nested under.
    let parent = false;
    if (b.item) {
      while (parents.length && parents[parents.length - 1].indent >= indent(b)) parents.pop();
      parent = parents[parents.length - 1]?.guard ?? false;
      parents.push({ indent: indent(b), guard: words[k] || parent });
    }
    const next = blocks[k + 1];
    const follows =
      next &&
      (!(b.item && next.item) || indent(next) > indent(b) || guarded(read[next.lines[0]].replace(LIST_ITEM, "").trim().split(/\s/, 1)[0]));
    if (words[k] || led || parent || (follows && words[k + 1])) continue;
    for (const i of b.lines) read[i] = cut[i];
  }
  return { raw, read: cutReleased(read) };
}

/** The lines with each unconditional "hold released" status blanked out, same length, so line indexes hold. @param {string[]} read */
function cutReleased(read) {
  const all = read.join("\n");
  const out = all.replace(RELEASED, (match, /** @type {string | undefined} */ who, /** @type {number} */ at) => {
    const from = at + match.length;
    const after = all.slice(from, from + 2000);
    // A paragraph that runs past what is read cannot be cleared; a window's cut end is not a paragraph's end.
    const cutShort = from + after.length < all.length;
    const [para] = after.split(cutShort ? BLANK_LINE : PARAGRAPH_END, 1);
    if (para.length === after.length && cutShort) return match;
    // The next paragraph is read whole, from its own start, so no sentence, list or heading mark inside it hides a
    // condition ("Hold released.\n\nOn condition that …"). A heading, a paragraph whose last line ends no sentence
    // (a label, an underline, a list) or one with an indented continuation under it reads on to the next.
    const tail = all.slice(from + para.length, from + para.length + 2000);
    const pieces = tail.split(BLANK_LINE);
    const tailCut = from + para.length + tail.length < all.length;
    let text = para;
    for (const [k, piece] of pieces.entries()) {
      if (k === pieces.length - 1 && tailCut) return match;
      const body = piece.replace(/^[\s>]+/, "");
      if (!body) continue;
      text += `\n${body}`;
      // The next paragraph that has text, past any further blank lines, decides whether this one reads on.
      let n = k + 1;
      while (n < pieces.length && !pieces[n].replace(/^[\s>]+/, "")) n += 1;
      // Only blank text left in a cut window cannot show whether what follows is indented.
      if (n === pieces.length && tailCut) return match;
      const next = (pieces[n] ?? "").replace(/^(?:[ \t]*(?:>[ \t]*)*\n)+/, "");
      // Any whitespace among or after the quote marks, but the one space each may carry, is an indent: fail closed.
      const indented = /[ \t]/.test((/^[ \t>]*/.exec(next)?.[0] ?? "").replace(/> ?/g, ">"));
      if (!/^#{1,6}(?:[ \t\n]|$)/.test(body) && SENTENCE_END.test(body.trimEnd()) && !indented) break;
    }
    if (RELEASED_IF.test(text.replace(EMPHASIS, ""))) return match;
    if (!who) return " ".repeat(match.length);
    const rest = after.split(/[.!;](?=\s|$)|\n[ \t]*(?:\n|$)/, 1)[0];
    return /^[ \t]*\?/.test(rest) || guarded(rest) ? match : " ".repeat(match.length);
  });
  return out === all ? read : out.split("\n");
}

/**
 * The first hold line in a text, trimmed, or null. It is never cut: a cut before the bridge's redactor can leave a
 * token's head it no longer recognises, so the bridge redacts the whole line and only then cuts it (redact-cut.mjs).
 * @param {string} text
 * @returns {string | null}
 */
export function holdLine(text) {
  const { raw, read } = readLines(text);
  const clean = (/** @type {string} */ r) => r.replace(PROSE_HOLDS, "$1").replace(NOT_A_HOLD, " ");
  // The section level of a governing lead-in, or -1; the indent of a list item's lead-in, or -1; whether the last line
  // with text is left open (no heading, no sentence end).
  let section = 0;
  let leadIn = -1;
  let leadItem = -1;
  let open = false;
  for (const [index, line] of read.entries()) {
    const readAs = readings(line);
    const wrapped = index > 0 && read[index - 1].trim() ? readings(read[index - 1].replace(/^[ \t]*(?:>[ \t]*)+/, "")) : null;
    const heading = /^[ \t>]*(#{1,6})(?:[ \t]|$)/.exec(line)?.[1].length ?? 0;
    if (heading) section = heading;
    if (heading && heading <= leadIn) leadIn = -1;
    if (heading && leadIn < 0 && LEAD_WORD.test(line)) leadIn = heading;
    const indent = /^[ \t>]*/.exec(line)?.[0].length ?? 0;
    if (heading || (line.trim() && indent <= leadItem)) leadItem = -1;
    const goesOn = leadIn >= 0 || leadItem >= 0 || (!heading && open);
    if (/:[*_`)\]"'\u201d\u2019]*[ \t]*$/.test(line)) {
      if (!LIST_ITEM.test(line) || LEAD_WORD.test(line)) leadIn = leadIn < 0 ? section : leadIn;
      else if (leadItem < 0) leadItem = indent;
    } else if (!heading && leadIn < 0 && line.trim() && !LIST_ITEM.test(line) && BLOCK_WORD.test(line)) leadIn = section;
    if (line.trim()) open = !heading && !/[.!?][*_)\]"'\u201d\u2019]*[ \t]*$/.test(line);
    if (!readAs.some((r, k) => HOLD_LINE.test(clean(r)) || heldOnHere(clean(r), wrapped && clean(wrapped[k])) || (goesOn && VERB_HOLD.test(clean(r))))) continue;
    // A "## Holds" heading over "None." is not a hold, read either way.
    let at = index + 1;
    while (at < read.length && !read[at].trim()) at += 1;
    if (at === read.length) at = -1;
    const next = at < 0 ? undefined : read[at];
    // Only a "None." that ends its paragraph: not one over a wrapped "Only after the owner approves.".
    const ends = !read[at + 1]?.trim() || /^[ \t]*#/.test(read[at + 1]);
    if (next !== undefined && ends && readAs.every((r) => HEADING.test(r)) && readings(next).every((r) => NONE.test(r))) continue;
    return raw[index].trim();
  }
  // Markdown soft wraps do not end an explicit merge-approval condition or a hold on the owner ("Merge held for\nthe owner").
  // Keep ordinary hold/negation parsing line-local; only these span lines.
  const approvalText = read.join("\n").replace(/^[ \t]*(?:>[ \t]*)+/gm, "");
  for (const readAs of readings(approvalText)) {
    const soft = readAs.replace(/\n(?![ \t]*(?:\n|$))/g, " ");
    const approval = MERGE_APPROVAL.exec(readAs) ?? REQUIRED.exec(readAs) ?? HELD_ON_RE.exec(readAs) ?? WRAPPED_HOLD.exec(soft);
    if (approval) return approval[0].replace(/\s+/g, " ");
  }
  return null;
}

/**
 * Whether a comment opens with an explicit release line: "Hold released",
 * "Unhold", alone or followed by ": <why>". A quoted line ("> Hold released")
 * is not one.
 * @param {string} text
 */
export function isRelease(text) {
  return RELEASE.test(lines(text)[0]);
}

// Who may release a hold by comment: the repository's owner login, which the owner, the monitor and the agents post as
// (GitHub's author association OWNER). Anyone else's release is read as plain text.
const TRUSTED = new Set(["OWNER"]);
// A `rivet hold` comment (scripts/rivet.mjs HOLD_OPENING): only `rivet unhold`, which edits it, ends it.
const isRivetHold = (/** @type {string} */ text) => text.replace(/[*_`]+/g, "").trimStart().toLowerCase().startsWith("owner hold: do not merge until");

/**
 * The texts whose hold lines are in force: the body, and each comment, review or review comment that no later
 * release supersedes. A release is a note from the owner login that opens with a release line (`isRelease`: "Hold
 * released: the owner chose Ship it") and has no word in it that denies or conditions it. It supersedes every note last
 * changed before it was posted, so a stale checkpoint's "Owner holds: draft and HELD." stops holding once the release
 * comes, while a hold written or edited after it still holds. A Rivet yes is not a release. The
 * release's own text after its release line is read like any note's. A note whose times cannot be read is never
 * superseded, nor is a `rivet hold` comment; the body holds until its hold line is edited out; labels and the holds
 * file are read elsewhere.
 * @param {{ body: string | null, notes: { body: string | null, posted?: string | null, changed?: string | null, association?: string | null }[] }} pr
 *   posted: when the note was posted; changed: when it last changed
 * @returns {string[]}
 */
export function currentTexts({ body, notes }) {
  const time = (/** @type {unknown} */ at) => (typeof at === "string" ? Date.parse(at) : NaN);
  let released = -Infinity;
  for (const note of notes) {
    const posted = time(note.posted);
    if (!TRUSTED.has(note.association ?? "") || !Number.isFinite(posted)) continue;
    const text = String(note.body ?? "");
    if (isPlainRelease(text)) released = Math.max(released, posted);
  }
  const live = notes.filter((note) => !(time(note.changed) < released) || isRivetHold(String(note.body ?? "")));
  return [String(body ?? ""), ...live.map((note) => {
    const text = String(note.body ?? "");
    return TRUSTED.has(note.association ?? "") && isPlainRelease(text) ? afterRelease(text) : text;
  })];
}

/**
 * A release with nothing in the whole comment that denies or conditions it: not "Hold released: only after #620 lands",
 * nor "Hold released: agreed,\nbut only after #620 lands".
 * @param {string} text
 */
const isPlainRelease = (text) => isRelease(text) && !guarded(afterRelease(text)) && !RELEASED_IF.test(afterRelease(text).replace(EMPHASIS, ""));
/** A release comment with its release line taken out of its first line. @param {string} text */
const afterRelease = (text) => {
  const [first, ...more] = lines(text);
  return [first.replace(RELEASE, ""), ...more].join("\n");
};

/**
 * The hold on a PR, or null: a hold line in the body, else the newest owner
 * comment hold that no later owner release clears. Comments oldest first;
 * comments from anyone outside `ownerLogins` are ignored.
 * @param {{ body: string, comments: { login: string, body: string }[] }} pr
 * @param {string[]} ownerLogins
 * @returns {{ where: "body" | "comment", line: string } | null}
 */
export function prHold(pr, ownerLogins) {
  const inBody = holdLine(pr.body);
  if (inBody !== null) return { where: "body", line: inBody };
  /** @type {string | null} */
  let held = null;
  for (const comment of pr.comments) {
    if (!ownerLogins.includes(comment.login)) continue;
    let text = comment.body;
    // A conditioned release ("Hold released\nonly after the owner approves") releases nothing and is read as written.
    if (isPlainRelease(text)) {
      held = null;
      text = afterRelease(text);
    }
    held = holdLine(text) ?? held;
  }
  return held === null ? null : { where: "comment", line: held };
}

// "hold" before a colon only as a label or an instruction, as the bridge reads it (NOT_VERB, #668).
const PLAIN_HOLD_LINE = new RegExp(`\\bhold\\b\\s*[*)]|\\bhold\\b${NOT_VERB}\\s*:|${/\b(?:owner|user|merge|deploy|monitor)(?:\/monitor)? hold\b|\bdo(?: not|n't) merge\b|(?:^(?:[\s>#*+-]|\[[ x]\]|\d+[.)])*|[;:,.!?]\s+|[\u2014\u2013]\s*)(?:(?:but|and|then|so|please|still|no|on)\s+)*hold(?:\s+[a-z#0-9]+){0,3}?\s+until\b|\bno\s+merge(?:\s+or\s+deploy)?\s+(?:until|before|without)\b/.source}`, "i");
// Each excuse is cut out of its line before the line is read, and counts only
// where it ends its clause: "Owner hold: none of the approvals are in" and "No
// hold may be released yet" still hold, and so does a comma or a dash after it.
// "No owner hold." excuses only as the line's last sentence: "No owner hold. No
// merge until #364 lands." holds, and so does "No owner hold" hard-wrapped over
// its qualifier. No "m" flag: "$" is the line's end.
const PLAIN_NOT_A_HOLD = /\bno hold(?=\s*(?:[.;)]|$))|\bholds?\b\s*[:*]*\s*(?:none|no)(?:\s+(?:from|by|on|for)\s+(?:the\s+)?(?:owners?|monitor))?(?:[ \t]*\((?:(?:the[ \t]+)?owners?[ \t]+)?(?:(?:has|have)[ \t]+)?(?:approved|oked|ok['\u2019]?d|okayed|signed[ \t]+off(?:[ \t]+on)?|agreed(?:[ \t]+to)?|gave[ \t]+(?:it[ \t]+)?the[ \t]+go-ahead(?:[ \t]+(?:for|on))?)(?:[ \t]+(?:(?:the|this|his|her|that)[ \t]+)?(?:plan|pr|change|changes|video|build|design|approach|fix|it|this))?[ \t]*\.?\))?\s*(?:[.;)]|$)|(?<=^[\s>*_-]*|[.;:!?)]\s+)no\s+(?:owner|user|merge|deploy|monitor)\s+holds?(?:\s*[.;](?=\s|$)|\s*,(?!\s*(?:$|\())(?!\s*(?:even|including|except|until|unless|no\s+matter|regardless|without|whatever|however|may|must|can|will|shall|is|are|only|once|after|before|pending|when|if)\b))/gi;

/**
 * The first hold line in these texts, or null: a line `holdLine` reads as a hold
 * ("Don’t merge", "Do **not** merge", "No owner hold*." over a footnote), else one of
 * this second reading's own, read with its paired Markdown marks taken out
 * ("**No owner hold**." is no hold). "No hold" and "holds: none" are cut out of a line
 * before it is read, so they excuse only themselves: "Hold: owner approval; there is
 * no hold expiry" still holds.
 * @param {string[]} texts
 */
export function holdLines(texts) {
  for (const text of texts) {
    const bridge = holdLine(String(text ?? ""));
    if (bridge !== null) return bridge;
    const { raw, read } = readLines(String(text ?? ""), (all) => all.split("\n"));
    for (const [index, line] of read.entries()) {
      const text = unpaired(line).replace(PLAIN_NOT_A_HOLD, " ");
      if (PLAIN_HOLD_LINE.test(text)) return raw[index].trim();
    }
  }
  return null;
}

/**
 * Every distinct hold line in the texts, in reading order, up to `max`: the server finds the owner's among them,
 * so a hold the monitor or an agent holds for itself, read first, never hides the owner's. A hold read across lines (a wrapped merge condition) has no one line to set aside, so the fewest lines that
 * read as it (or, failing that, its paragraph) are set aside instead; should none, that text's reading ends there.
 * @param {string[]} texts @param {number} [max]
 * @returns {string[]}
 */
export function allHolds(texts, max = 20) {
  /** @type {string[]} */
  const found = [];
  for (const text of texts) {
    let rest = String(text ?? "");
    while (found.length < max) {
      const hold = holdLines([rest]);
      if (hold === null) break;
      if (!found.includes(hold)) found.push(hold);
      let next = lines(rest).map((line) => (line.trim() === hold ? "" : line)).join("\n");
      if (next === rest) next = withoutWrapped(rest, hold);
      if (next === rest) break;
      rest = next;
    }
  }
  return found;
}

/**
 * The text with the fewest consecutive lines (up to six) that read as `hold` blanked, so the next hold in the same
 * paragraph is still read; failing that, the paragraph that reads as it; the text unchanged when neither does.
 * @param {string} text @param {string} hold
 */
function withoutWrapped(text, hold) {
  const all = lines(text);
  for (let size = 2; size <= Math.min(6, all.length); size += 1) {
    for (let start = 0; start + size <= all.length; start += 1) {
      if (holdLines([all.slice(start, start + size).join("\n")]) !== hold) continue;
      return all.map((line, i) => (i >= start && i < start + size ? "" : line)).join("\n");
    }
  }
  return text.split(/\n[ \t]*\n/).map((part) => (holdLines([part]) === hold ? "" : part)).join("\n\n");
}

/**
 * A line that is only a wait for the owner's OK on a video, read whole (Markdown marks, a list or quote mark and a
 * trailing full stop aside): "Merge waits for the owner's OK on the video.", "Owner hold: the owner OKs the video". It names
 * the owner and carries no other condition, so a line with more in it ("…and legal review", "playtest the visual
 * overhaul") never reads as one. src/shared/pr-holds.ts mirrors it; a test keeps them in step.
 */
export const VIDEO_WAIT_LINE =
  /^(?:(?:owner\s+)?hold:\s*)?(?:merge\s+)?(?:(?:waits?|waiting|held|blocked)\s+(?:for|on|until)\s+)?the\s+owner(?:'s|’s)?\s+(?:oks?|okay|approv(?:al|es)|sign[- ]?off)\s+(?:(?:on|of|for)\s+)?(?:the\s+)?(?:(?:before\/after|after|proposal)\s+)?video$/i;

/** @param {string} line */
export function isVideoWaitLine(line) {
  const text = line
    .replace(/[*_`~]+/g, "")
    .trim()
    .replace(/^(?:>\s*)*(?:[-+*]\s+|\d+[.)]\s+)?/, "")
    .replace(/\s*\.$/, "");
  return VIDEO_WAIT_LINE.test(text);
}

/** A heading line, after its indent. */
const HEADING_LINE = /^[ \t>]*#{1,6}(?:[ \t]|$)/;
/** @param {string} line */
const indentOf = (line) => /^[ \t>]*/.exec(line)?.[0].length ?? 0;

/**
 * Whether every hold in these texts is a wait for the owner's video OK (isVideoWaitLine), read from the raw texts so
 * a hold that redaction hides still counts. A video-wait line counts only standing alone, the last line of its
 * text or section, so nothing written after it can add a condition ("Only after the owner signs off too."). With those
 * lines blanked nothing may hold: read whole, then each text that had one by paragraph and line by line (reading a
 * part alone can only find more holds, never fewer; a text with no such line is read whole only, so a decision
 * record quoting the wait stays no hold). Over-reading only shows the owner a card.
 * @param {string[]} texts
 */
export function videoWaitOnly(texts) {
  if (holdLines(texts) === null) return false;
  const parts = [];
  const blanked = [];
  for (const text of texts) {
    const all = lines(String(text ?? ""));
    const waits = all.map((line) => isVideoWaitLine(line));
    // Past blank lines, only a heading no deeper than the wait, or the text's end, may follow it: a next line, list item or
    // paragraph can carry it on ("+ and the owner signs off", "#620 must land first.").
    for (const [i, wait] of waits.entries()) {
      const after = wait ? all.slice(i + 1).find((line) => line.trim()) : undefined;
      if (after !== undefined && !(HEADING_LINE.test(after) && indentOf(after) <= indentOf(all[i]))) return false;
    }
    const out = all.map((line, i) => (waits[i] ? "" : line));
    blanked.push(out.join("\n"));
    if (waits.some(Boolean)) parts.push(...out.join("\n").split(/\n\s*\n/), ...out);
  }
  return holdLines(blanked) === null && parts.every((part) => !part.trim() || holdLines([part]) === null);
}
