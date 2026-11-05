import { z } from "zod";

import { ASK, MERGE_READY, PLAN, UPDATE } from "./answers.js";
import { isRepo, NO_REPO, REPO_RE, setDefaultRepo } from "./repos.js";
import { NEEDS_YOU } from "./words.js";

export { NO_REPO, setDefaultRepo };

// Shared by the server (validation) and the web app (types only). Unknown keys
// pass through so Rivet can grow the board without a server deploy, but every
// field the UI renders or the bridge acts on is checked here.

// These rules mirror bridge/lib/validate.mjs and must stay at least as strict,
// or the server accepts a card whose replies the bridge then drops.
export const ID_PATTERN = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;
export const CHAT_PATTERN = ID_PATTERN;
export const REV_PATTERN = /^[0-9a-f]{16}$/;
export const MAX_REPLY_TEXT = 4000;
export const MAX_CHOICE = 200;
export const MAX_CHOICE_DETAIL = 1000;
/** An option's `short`: what the Feed's answer buttons show. */
export const MAX_SHORT = 40;
export const MAX_STEPS = 12;
export const MAX_STEP = 300;
export const MAX_POINTS = 8;
export const MAX_POINT = 200;
export const MAX_ETA = 40;
export const PLAN_SIZES = ["S", "M", "L"] as const;

const text = (max: number) => z.string().max(max);
const timestamp = z.string().max(64);
const number = z.number().int().positive().max(1_000_000_000);

const httpsUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "links must be https URLs");

export const riskSchema = z.enum(["money", "auth", "fairness"]);

export const optionSchema = z
  .object({
    label: text(MAX_CHOICE).refine((value) => value.trim() !== "", "option labels must not be blank"),
    short: text(MAX_SHORT).optional(),
    detail: text(MAX_CHOICE_DETAIL).optional(),
    recommended: z.boolean().optional(),
    /** Picking this option asks you to type what you mean before it sends. */
    text: z.boolean().optional(),
  })
  .passthrough();

export const linkSchema = z
  .object({
    label: text(200).min(1),
    url: httpsUrl,
    primary: z.boolean().optional(),
  })
  .passthrough();

export const mediaRefSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    type: z.enum(["video/mp4", "video/webm", "image/jpeg", "image/png"]),
  })
  .strict();

export const MAX_STILLS = 8;
export const MAX_AUDIO_CLIPS = 6;

/** A sound clip on a card, such as one voice to pick from, with a short label to tell them apart. */
export const audioClipSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    type: z.enum(["audio/mpeg", "audio/mp4"]),
    label: text(40)
      .refine((value) => value.trim() !== "", "audio labels must not be blank")
      .optional(),
  })
  .strict();

export const MAX_FILES = 4;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
/** A download name: letters, digits, spaces and . _ - ( ), starting with a letter or digit, ending .pdf, 100 at most. */
export const PDF_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,95}\.pdf$/;

/** Any name as a safe PDF download name (see PDF_NAME_PATTERN); "document.pdf" when nothing is left. */
export function pdfFileName(raw: string): string {
  const stem = raw
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9 ._()-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 96)
    .trimEnd();
  return stem ? `${stem}.pdf` : "document.pdf";
}

/**
 * The documents, videos and sound you may attach to a chat message or a card reply, by extension; photos keep their
 * own path (IMAGE_TYPES), but a HEIC (the phone may not draw it) or a GIF (a redraw stops it moving) comes as it is.
 * Nothing that can run code: no SVG, no HTML; an email (.eml, .msg) is only ever a download, never shown. The first extension of a type is its own, used when a name has none of
 * that type's.
 */
export const FILE_EXTENSIONS = {
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
  zip: "application/zip",
  glb: "model/gltf-binary",
  eml: "message/rfc822",
  msg: "application/vnd.ms-outlook",
} as const;
export type FileType = (typeof FILE_EXTENSIONS)[keyof typeof FILE_EXTENSIONS];
export const FILE_TYPES = [...new Set(Object.values(FILE_EXTENSIONS))] as readonly FileType[];
/** Video and sound you attach (a track, a screen recording): a few minutes of it, so a cap of its own. */
export const AV_TYPES = ["video/mp4", "video/quicktime", "video/webm", "audio/mpeg", "audio/mp4", "audio/wav", "audio/aac", "audio/ogg", "audio/flac"] as const satisfies readonly FileType[];
export const MAX_AV_BYTES = 100 * 1024 * 1024;
export const isAvType = (type: string): boolean => (AV_TYPES as readonly string[]).includes(type);
/** Files that take video and sound's cap: those, a ZIP (a folder of art or sounds at once) and a 3D model. */
export const BIG_TYPES = [...AV_TYPES, "application/zip", "model/gltf-binary"] as const satisfies readonly FileType[];
export const isBigType = (type: string): boolean => (BIG_TYPES as readonly string[]).includes(type);
/** Documents in one chat message, one chat window or one card reply. */
export const MAX_CHAT_FILES = 5;
/** Photos in one chat message, one chat window or one card reply. */
export const MAX_CHAT_IMAGES = 10;
/** An attachment's name: attachmentName's output, a letters-and-digits start, 96 characters of stem at most. */
export const ATTACHMENT_NAME_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,95}\\.(?:${Object.keys(FILE_EXTENSIONS).join("|")})$`);

/** The type a name's extension says, or null when it is not a document you may attach. */
export function fileTypeOf(name: string): FileType | null {
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim())?.[1]?.toLowerCase();
  return extension && Object.hasOwn(FILE_EXTENSIONS, extension) ? FILE_EXTENSIONS[extension as keyof typeof FILE_EXTENSIONS] : null;
}

/**
 * Any name as a safe attachment name of `type`, with pdfFileName's character policy: the name's own extension
 * when it is one of `type`'s, else the type's own; "file.<ext>" when nothing of the stem is left.
 */
export function attachmentName(raw: string, type: FileType): string {
  const trimmed = raw.trim();
  const own = /\.([A-Za-z0-9]{1,10})$/.exec(trimmed)?.[1]?.toLowerCase();
  const extensions = Object.keys(FILE_EXTENSIONS).filter((key) => FILE_EXTENSIONS[key as keyof typeof FILE_EXTENSIONS] === type);
  const extension = own && extensions.includes(own) ? own : extensions[0]!;
  const stem = (own === extension ? trimmed.slice(0, -extension.length - 1) : trimmed)
    .replace(/[^A-Za-z0-9 ._()-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 96)
    .trimEnd();
  return `${stem || "file"}.${extension}`;
}

/** A document you attached (POST /api/files), under the name the server gave it. */
export const fileRefSchema = z
  .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), name: z.string().regex(ATTACHMENT_NAME_PATTERN) })
  .strict();
export type FileRef = z.infer<typeof fileRefSchema>;
/** 1 to MAX_CHAT_FILES documents, none twice. */
export const fileRefsSchema = z
  .array(fileRefSchema)
  .min(1)
  .max(MAX_CHAT_FILES)
  .refine((files) => new Set(files.map((file) => file.sha256)).size === files.length, "a file is attached twice");

/**
 * A document on a card, such as a white paper or a log, saved or shared under `name`: a PDF named as pdfFileName
 * names one, any other document as attachmentName does, with its own type's extension.
 */
export const cardFileSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    type: z.enum(FILE_TYPES as [FileType, ...FileType[]]),
    name: z.string(),
    bytes: z.number().int().positive().max(MAX_PDF_BYTES),
  })
  .strict()
  .refine(
    (file) => (file.type === "application/pdf" ? PDF_NAME_PATTERN.test(file.name) : ATTACHMENT_NAME_PATTERN.test(file.name) && fileTypeOf(file.name) === file.type),
    { message: "a file's name must be a safe name ending in its type's extension" },
  );

const stillRefSchema = mediaRefSchema.refine((ref) => ref.type.startsWith("image/"), { message: "stills must be jpeg or png" });

/**
 * Before/after video on a card, up to MAX_STILLS screenshots, up to MAX_AUDIO_CLIPS sound clips and up to
 * MAX_FILES documents; the files are served from `/media/<sha256>`. A card with screenshots only is kind
 * `stills`, one with sound and no video kind `audio`, one with documents only kind `files`.
 */
export const mediaSchema = z
  .object({
    kind: z.enum(["before-after", "video", "stills", "audio", "files"]),
    before: mediaRefSchema.optional(),
    after: mediaRefSchema.optional(),
    poster: mediaRefSchema.optional(),
    stills: z.array(stillRefSchema).min(1).max(MAX_STILLS).optional(),
    clips: z.array(audioClipSchema).min(1).max(MAX_AUDIO_CLIPS).optional(),
    files: z.array(cardFileSchema).min(1).max(MAX_FILES).optional(),
  })
  .strict()
  .refine(
    (media) =>
      media.kind === "video"
        ? Boolean(media.after ?? media.before)
        : media.kind === "stills"
          ? Boolean(media.stills)
          : media.kind === "audio"
            ? Boolean(media.clips)
            : media.kind === "files"
              ? Boolean(media.files)
              : Boolean(media.before && media.after),
    { message: "before-after needs both videos; video needs one; stills needs a still; audio needs a clip; files needs a document" },
  );

/** Every file a card's media names. */
export function mediaShas(media: Media | undefined): string[] {
  if (!media) return [];
  return [media.before, media.after, media.poster, ...(media.stills ?? []), ...(media.clips ?? []), ...(media.files ?? [])].flatMap((ref) => (ref ? [ref.sha256] : []));
}

export { ASK, UPDATE };
export const MAX_COMMENTS = 20;
export const MAX_COMMENT = 1000;

/** A line under an update card: your comment, or Rivet's answer to it. (`comments`, not `notes`: older cards use that freely.) */
export const commentSchema = z
  .object({
    from: z.enum(["owner", "rivet"]),
    text: text(MAX_COMMENT).refine((value) => value.trim() !== "", "comments must not be blank"),
    at: timestamp,
  })
  .strict();
export type CardComment = z.infer<typeof commentSchema>;

const noteText = (max: number) => text(max).refine((value) => value.trim() !== "", "must not be blank");

/** A question card's proof: what you check before you say yes, so you need not open the PR. */
export const evidenceSchema = z
  .object({
    ci: z.enum(["green", "red", "running"]).optional(),
    ciNote: noteText(120).optional(),
    review: z.enum(["clean", "findings", "running"]).optional(),
    reviewNote: noteText(160).optional(),
    /** Why the card needs you rather than the crew. */
    why: noteText(300).optional(),
    /** What stops the merge, one line each. */
    holding: z.array(noteText(120)).max(5).optional(),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema>;

export const needSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    kind: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    title: text(300).min(1),
    ask: text(4000).optional(),
    chat: z.string().regex(CHAT_PATTERN).optional(),
    since: timestamp.optional(),
    pr: number.optional(),
    issue: number.optional(),
    repo: z.string().regex(REPO_RE).optional(),
    /** A merge-ready card's PR head that its gate was clean on: the only head its yes merges. */
    headSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    risk: riskSchema.optional(),
    options: z.array(optionSchema).max(20).optional(),
    /** "text": the card asks a question, so a typed answer replaces Approve. */
    reply: z.enum(["text"]).optional(),
    /**
     * The chat message (your ask, Rivet's line) or the card this card was made for: its conversation is the card's,
     * and its answers and comments land there (2026-10-09). Unset, the server matches one (src/server/routes/conversations.ts).
     */
    replyTo: z.string().regex(ID_PATTERN).optional(),
    /** How its push lands; unset, the kind decides (push.ts KIND_LEVELS). */
    push: z.enum(["needs-you", "fyi"]).optional(),
    links: z.array(linkSchema).max(20).optional(),
    media: mediaSchema.optional(),
    /** A todo card's numbered steps, which you do yourself before you tap Done. */
    steps: z
      .array(text(MAX_STEP).min(1).refine((step) => step.trim() !== "", "steps must not be blank"))
      .min(1)
      .max(MAX_STEPS)
      .optional(),
    /** An update card's thread, the pile it stacks in ("Billing", "main"); the server fills it when the writer does not. */
    thread: text(80).refine((value) => value.trim() !== "", "a thread must not be blank").optional(),
    /** An update card's tag: what happened (Merged, Deployed, Red fixed, Chat finished, Nightly…). */
    tag: text(40).refine((value) => value.trim() !== "", "a tag must not be blank").optional(),
    /** An update card's lines under it, oldest first: your comments and Rivet's answers. */
    comments: z.array(commentSchema).max(MAX_COMMENTS).optional(),
    /** A plan card's dot points under its main point. */
    points: z
      .array(text(MAX_POINT).min(1).refine((point) => point.trim() !== "", "points must not be blank"))
      .min(1)
      .max(MAX_POINTS)
      .optional(),
    /** A plan card's size of work. */
    size: z.enum(PLAN_SIZES).optional(),
    /** A plan card's ETA as you read it ("~2:30pm", "today"). */
    eta: text(MAX_ETA).refine((value) => value.trim() !== "", "an eta must not be blank").optional(),
    evidence: evidenceSchema.optional(),
    /**
     * Server-owned: you tapped Answer again `n` times, the last time on the answer `after`. A new revision, so
     * your new answer is recorded on it, and relayed as a change of that one; a writer's own is never kept. `at`: when you
     * reopened it, for the card's band; absent on one reopened before Reopen kept the time.
     */
    again: z.object({ n: z.number().int().min(1).max(1000), after: z.string().regex(ID_PATTERN), at: z.string().datetime().optional() }).strict().optional(),
  })
  .passthrough()
  // Steps only ever mean "do these, then tap Done": a todo card needs them and no other kind takes them.
  .superRefine((need, ctx) => {
    if (need.kind === "todo" && !need.steps) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "a todo card needs steps" });
    } else if (need.kind !== "todo" && need.steps) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "only a todo card takes steps" });
    }
    if (need.kind === MERGE_READY && need.pr === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pr"], message: "a merge-ready card needs pr" });
    }
    if (need.kind === MERGE_READY && need.headSha === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headSha"], message: "a merge-ready card needs headSha" });
    } else if (need.kind !== MERGE_READY && need.headSha !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headSha"], message: "only a merge-ready card takes headSha" });
    }
    // An update card answers nothing: Seen and Comment are its only buttons, so nothing that asks goes on one.
    if (need.kind === UPDATE) {
      for (const field of ["options", "reply", "risk", "evidence"] as const) {
        if (need[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `an update card takes no ${field}: make it a question card` });
      }
    } else {
      for (const field of ["thread", "tag", "comments"] as const) {
        if (need[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `only an update card takes ${field}` });
      }
    }
    // A plan's one yes is "Yes, go", so it takes no options or typed answer; only a plan takes points, size and eta.
    if (need.kind === PLAN) {
      for (const field of ["options", "reply"] as const) {
        if (need[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `a plan card takes no ${field}: its yes starts the build` });
      }
    } else {
      for (const field of ["points", "size", "eta"] as const) {
        if (need[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `only a plan card takes ${field}` });
      }
    }
    // The answer that arms it must be one option only: a second option with that label would arm with it.
    if (need.kind === MERGE_READY && need.options) {
      if (new Set(need.options.map((option) => option.label)).size !== need.options.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "a merge-ready card's options need different labels" });
      }
      if (need.options.filter((option) => option.recommended).length !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "a merge-ready card's options need exactly one recommended" });
      }
    }
  });

const prTitleSchema = z
  .object({ pr: number.optional(), title: text(300).min(1) })
  .passthrough();

/** Where a coming item is, in order; `owner-ok` waits on you, `shipped` means deployed. */
export const COMING_STAGES = ["building", "review", "owner-ok", "merging", "deploying", "shipped"] as const;
/** Each Coming stage as you read it, on the Coming cards. */
export const STAGE_LABELS: Record<(typeof COMING_STAGES)[number], string> = {
  building: "Building",
  review: "In review",
  "owner-ok": NEEDS_YOU,
  merging: "Merging",
  deploying: "Deploying",
  shipped: "Deployed",
};

/** A week: an ETA past that is a guess, not an estimate. */
export const MAX_ETA_MINUTES = 7 * 24 * 60;

/**
 * What a chat or a coming PR is up to at a glance, shared by `coming[]` and `chats[]`; all optional, so an old
 * entry shows its name only. `what` is one line (views clamp it); `progress` is overall, 0 to 1; `etaMinutes`
 * counts from `updatedAt` when that is set.
 */
export const progressShape = {
  what: text(200).min(1).optional(),
  progress: z.number().min(0).max(1).optional(),
  etaMinutes: z.number().int().min(0).max(MAX_ETA_MINUTES).optional(),
  updatedAt: timestamp.optional(),
};

/**
 * One item on its way. `title` alone still renders (the board before 2026-09-30); the card and its progress bar
 * use the rest when Rivet fills it, and the bar keeps `progress` inside the current stage's share.
 */
export const comingSchema = prTitleSchema.extend({
  ...progressShape,
  app: text(80).min(1).optional(),
  stage: z.enum(COMING_STAGES).optional(),
  chat: z.string().regex(CHAT_PATTERN).optional(),
  /** When you asked for it (ISO), for the Coming list's "Requested" order; without it the list uses `updatedAt`. */
  requestedAt: timestamp.optional(),
  /** The server's own (src/server/stamps.ts): when a write last changed or named this row; a sent value is replaced. */
  touchedAt: timestamp.optional(),
  /**
   * The server's own: when GitHub's merged list first showed the row's PR, in the repo of the chat the row names. Kept
   * after the PR leaves that list; a sent value is replaced. Null is accepted for a row stored before the field was
   * the server's, and counts as not merged.
   */
  mergedAt: timestamp.nullish(),
  /** The server's own: the repo `mergedAt` was read in, so the merge stays with that repo's PR; a sent value is replaced. */
  mergedRepo: z.string().regex(REPO_RE).optional(),
});

/** A chat's `stage` is free text (a chat is not always a PR); a coming item's is one of COMING_STAGES. */
export const chatSchema = z
  .object({
    name: z.string().regex(CHAT_PATTERN),
    state: text(40),
    doing: text(1000).optional(),
    prs: z.array(number).max(50).optional(),
    moved: timestamp.optional(),
    ...progressShape,
    stage: text(40).min(1).optional(),
    /** The repo this chat is listed under, when that is not the repo of its worktree (`repo`). */
    project: z.string().regex(REPO_RE).optional(),
    /** The server's own, as on a coming row. */
    touchedAt: timestamp.optional(),
  })
  .passthrough();

/** The most shipped rows a board holds; settlement keeps the newest. */
export const MAX_SHIPPED = 200;

export const shippedSchema = z
  .object({
    pr: number.optional(),
    /** The PR's repo when it is not the default repo; settlement writes it for a Coming row of another repo. */
    repo: z.string().regex(REPO_RE).optional(),
    title: text(300).min(1),
    // Rivet writes true/false once a deploy is confirmed, or a word such as
    // "partial" while it is still going out.
    deployed: z.union([z.boolean(), text(40)]).optional(),
    deployedNote: text(300).optional(),
    /**
     * The server's own: when the row first reached the list. A row from before the stamps takes its own `at`, else
     * null: the day is not known, and it never counts as recent.
     */
    shippedAt: timestamp.nullable().optional(),
    touchedAt: timestamp.optional(),
  })
  .passthrough();

/** "owner/name" or a bare repo folder name such as "example-repo". */
export const REPO_REF_PATTERN = /^[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100})?$/;

export const boardSchema = z
  .object({
    updatedAt: timestamp,
    needs: z.array(needSchema).max(200).default([]),
    coming: z.array(comingSchema).max(200).default([]),
    chats: z.array(chatSchema).max(200).default([]),
    shipped: z.array(shippedSchema).max(MAX_SHIPPED).default([]),
  })
  .passthrough()
  .superRefine((board, ctx) => {
    const seen = new Set<string>();
    board.needs.forEach((need, index) => {
      if (seen.has(need.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["needs", index, "id"], message: "duplicate need id" });
      }
      seen.add(need.id);
    });
  });

export type Risk = z.infer<typeof riskSchema>;
export type MediaRef = z.infer<typeof mediaRefSchema>;
export type AudioClip = z.infer<typeof audioClipSchema>;
export type CardFile = z.infer<typeof cardFileSchema>;
export type Media = z.infer<typeof mediaSchema>;
export type Need = z.infer<typeof needSchema>;
export type ComingItem = z.infer<typeof comingSchema>;
export type ComingStage = (typeof COMING_STAGES)[number];
export type Progress = { what?: string; progress?: number; etaMinutes?: number; updatedAt?: string; stage?: string };
/** A need as GET /api/board serves it: `rev` pins a reply to the card you saw; `seen`, an update card you saw at that rev. */
export type ServedNeed = Need & { rev: string; seen?: true };
export type ServedBoard = { [K in keyof Board as K extends "needs" ? never : K]: Board[K] } & { needs: ServedNeed[] };
export type BoardChat = z.infer<typeof chatSchema>;
export type Board = z.infer<typeof boardSchema>;

/**
 * `done`: you did a todo card's steps yourself; it approves nothing. `seen`: you read an update card; it goes to no
 * chat. `dismiss`: you took a card off your Feed unanswered; it approves, rejects and merges nothing, and tells the
 * chat (and Rivet) to stop asking it.
 */
export const decisionSchema = z.enum(["approve", "reject", "choice", "comment", "done", "seen", "dismiss"]);
export type Decision = z.infer<typeof decisionSchema>;

const imageSha = z.string().regex(/^[0-9a-f]{64}$/);

export const replyCreateSchema = z
  .object({
    clientId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
    itemId: z.string().regex(ID_PATTERN),
    decision: decisionSchema,
    rev: z.string().regex(REV_PATTERN),
    choice: text(MAX_CHOICE).min(1).optional(),
    text: text(MAX_REPLY_TEXT).optional(),
    /** The sha256 of an image you attached (POST /api/images); one photo travels here, as clients before several photos sent it. */
    image: imageSha.optional(),
    /** The photos you attached, in the order you picked them; the server keeps one as `image`. */
    images: z.array(imageSha).min(1).max(MAX_CHAT_IMAGES).optional(),
    /** Documents you attached (POST /api/files); the server checks each is still stored and names it again. */
    files: fileRefsSchema.optional(),
    confirm: z.boolean().optional(),
  })
  .refine((value) => value.image === undefined || value.images === undefined, "send image or images, not both")
  .refine((value) => new Set(value.images).size === (value.images?.length ?? 0), "an image is attached twice");
export type ReplyCreate = z.infer<typeof replyCreateSchema>;

export const deliverySchema = z.object({
  target: z.enum(["chat", "rivet"]),
  chat: z.string().regex(CHAT_PATTERN).optional(),
  at: timestamp,
  /** The bridge saw the line land in the chat's terminal. */
  confirmed: z.boolean().optional(),
  stages: z.array(text(100).min(1)).max(20).optional(),
  /** The session's transcript never held the line, even after a retry: the answer has not reached anyone. */
  lost: z.boolean().optional(),
  unproved: z.boolean().optional(),
});

export const githubResultSchema = z.object({
  url: httpsUrl.optional(),
  error: text(1000).optional(),
});

export const bridgeAckSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  delivery: deliverySchema.optional(),
  github: githubResultSchema.optional(),
  error: text(1000).optional(),
});
export type BridgeAck = z.infer<typeof bridgeAckSchema>;

export interface ReplyItem {
  id: string;
  title: string;
  kind: string;
  ask?: string;
  /** The selected option's detail as shown when the owner answered. */
  choiceDetail?: string;
  steps?: string[];
  chat?: string;
  pr?: number;
  issue?: number;
  repo?: string;
  risk?: Risk;
  /** The answer arms the PR's merge (a merge-ready card's yes), so the bridge posts no GitHub decision comment. */
  merge?: true;
  /** A merge-ready card's head: the one its yes merges. */
  headSha?: string;
  /** Answered after Answer again: the earlier answer this one changes. */
  changes?: { replyId: string; decision: Decision; choice?: string };
}

export interface Reply {
  id: string;
  /** The idempotency key the web app sent the reply with. */
  clientId?: string;
  itemId: string;
  itemTitle: string;
  decision: Decision;
  choice?: string;
  text?: string;
  /** The sha256 of an image you attached, served at /media/<sha256>. */
  image?: string;
  /** Two or more images you attached; one comes as `image`. */
  images?: string[];
  /** Documents you attached, served at /media/<sha256>; they go to the chat only, never to GitHub. */
  files?: FileRef[];
  /** The rev of the card the reply answered. */
  rev: string;
  at: string;
  handled: boolean;
  handledAt?: string;
  /** Rivet marked it handled (POST /api/replies/:id/handled): acted on, not only delivered. */
  actedAt?: string;
  item: ReplyItem;
  delivery?: z.infer<typeof deliverySchema>;
  github?: z.infer<typeof githubResultSchema>;
  /** The bridge's last reported failure, if any. */
  error?: string;
}

export interface BoardResponse {
  version: number;
  updatedAt: string | null;
  board: ServedBoard | null;
  /** Cards and Done rows you minimised, as [key, rev]: out of every count on every phone until the revision changes. */
  minimised?: [string, string][];
}

/** A minimised key: a card id, or `reply:<id>` for a Done row. */
export const MINIMISED_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

/** GET /api/updates/older: seen update cards no longer on the board, the last seen first; `next` reads the page after. */
export interface OlderUpdatesResponse {
  cards: (ServedNeed & { seenAt: string })[];
  next: { before: string; id: string } | null;
}

export interface StatusResponse {
  board: { version: number; updatedAt: string | null };
  bridge: { connected: boolean; lastSeenAt: string | null };
}

/** A button on a card's notification: "yes" and "no" answer it, "seen" marks an update card, "later" only closes it. */
export type PushActionId = "yes" | "no" | "seen" | "later";
export interface PushAction {
  action: PushActionId;
  title: string;
}
/** What a notification button sends to POST /api/replies, with the card's id and the rev the push was made at. */
export interface PushAnswer {
  decision: Decision;
  choice?: string;
}

export interface PushConfigResponse {
  configured: boolean;
  publicKey: string | null;
  /** Phones the server can push to; 0 means a push reaches nobody. */
  subscriptions: number;
  /** The latest phone the server dropped, so the app can say why notifications stopped; null when none ever was. */
  lastRemoval: PushRemoval | null;
}

/**
 * Why the server dropped a phone. gone: its push service answered 404 or 410, which is what Android and iOS do once
 * notifications are blocked for the app. turned-off: Settings turned it off. cap: past
 * MAX_PUSH_SUBSCRIPTIONS the oldest goes.
 */
export type PushRemovalReason = "gone" | "turned-off" | "cap";

export interface PushRemoval {
  at: string;
  reason: PushRemovalReason;
  /** The push service's answer for `gone`, else null. */
  status: number | null;
  /** The push service's host only: the rest of an endpoint is a capability to push to that phone. */
  host: string;
  /** Phones left after it. */
  remaining: number;
}

/**
 * zod's `datetime({ offset: true })` takes any two-digit offset ("+99:99"), which Date cannot read and `toISOString`
 * then throws on; a real offset is at most ±14:00.
 */
export function isRealTime(text: string): boolean {
  const offset = /([+-])(\d\d):?(\d\d)$/.exec(text);
  return Number.isFinite(Date.parse(text)) && (!offset || (Number(offset[3]) < 60 && Number(offset[2]) * 60 + Number(offset[3]) <= 14 * 60));
}

export type Repo = string;

/** A board chat's repo when it names one; undefined means the default repo. */
export function chatRepo(chat: object): Repo | undefined {
  const repo = (chat as Record<string, unknown>).repo;
  return isRepo(repo) ? repo : undefined;
}

/**
 * The repo of the board chat a Coming item names, from the chats holding the item's PR (else all with that name).
 * Undefined means the default repo; null means two repos claim it, so the board's order cannot choose and nothing is
 * guessed.
 */
export function comingChatRepo(chats: readonly BoardChat[], name: string, pr?: number): Repo | undefined | null {
  const repos = comingChatRepos(chats, name, pr);
  return repos.size > 1 ? null : chatRepo({ repo: [...repos][0] });
}

/**
 * Every repo that could be the one comingChatRepo resolves: those of the chats holding the PR, else of all so named. A
 * numbered name no chat has (`daily-build-73`) is its chat's (`daily-build`) when that chat holds the PR, as the Feed
 * reads it.
 */
export function comingChatRepos(chats: readonly BoardChat[], name: string, pr?: number): Set<Repo> {
  const exact = chats.filter((chat) => chat.name === name);
  const base = typeof name === "string" ? name.replace(/-\d+$/, "") : name;
  const bases = exact.length || base === name ? [] : chats.filter((chat) => chat.name === base);
  // A base chat that does not hold the PR leaves its repo and the default both possible: two repos, nothing guessed, so
  // settlement never drops the row on the default repo's PR of that number.
  if (bases.length && pr !== undefined && !bases.some((chat) => chat.prs?.includes(pr))) {
    return new Set([...bases.map((chat) => chatRepo(chat) ?? NO_REPO), NO_REPO]);
  }
  const named = exact.length ? exact : bases;
  const holding = pr === undefined ? [] : named.filter((chat) => chat.prs?.includes(pr));
  return new Set((holding.length ? holding : named).map((chat) => chatRepo(chat) ?? NO_REPO));
}
