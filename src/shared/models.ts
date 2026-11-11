import { z } from "zod";

import table from "../../config/model-jobs.json";

// Settings › Who does what: the model and effort each kind of job runs on. The table is config/model-jobs.json, which
// the bridge reads too (bridge/lib/model-routing.mjs); the job keys are the ones scripts/model-routing.mjs reads.

export const MODEL_JOB_KEYS = ["monitor", "work-chats", "app-look", "review-lens", "hard-problem", "small-jobs", "daily-jobs", "night-jobs"] as const;
export type ModelJobKey = (typeof MODEL_JOB_KEYS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const EFFORT_LABELS: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

export interface ModelJob {
  key: ModelJobKey;
  label: string;
  /** What the job covers, the row's sub-line. */
  what: string;
  /** The models it may run on; the first is its default. */
  models: string[];
  /** A model's efforts on this job, where narrower than the model's own. */
  efforts?: Partial<Record<string, Effort[]>>;
  effort: Effort;
}

export const MODELS: Readonly<Record<string, { label: string; efforts: readonly Effort[] }>> = table.models as Record<string, { label: string; efforts: Effort[] }>;
export const MODEL_JOBS: readonly ModelJob[] = table.jobs as ModelJob[];

export interface ModelPick {
  model: string;
  effort: Effort;
}
export type ModelPicks = Record<ModelJobKey, ModelPick>;

export const modelLabel = (model: string): string => MODELS[model]?.label ?? model;
export const effortsFor = (model: string, job: ModelJob): readonly Effort[] => job.efforts?.[model] ?? MODELS[model]?.efforts ?? [];
export const jobOf = (key: string): ModelJob | undefined => MODEL_JOBS.find((job) => job.key === key);

export function isAllowed(job: string, model: string, effort: string): boolean {
  const found = jobOf(job);
  return !!found && found.models.includes(model) && (effortsFor(model, found) as readonly string[]).includes(effort);
}

/** The effort a job keeps when its model changes: the same one if the new model takes it, else the job's, else the new model's highest. */
export function effortOnModel(job: ModelJob, model: string, effort: Effort): Effort {
  const allowed = effortsFor(model, job);
  if (allowed.includes(effort)) return effort;
  return allowed.includes(job.effort) ? job.effort : allowed[allowed.length - 1]!;
}

export const defaultPick = (job: ModelJob): ModelPick => ({ model: job.models[0]!, effort: job.effort });
export const defaultPicks = (): ModelPicks => Object.fromEntries(MODEL_JOBS.map((job) => [job.key, defaultPick(job)])) as ModelPicks;

export const modelPickSchema = z.object({ model: z.string().max(60), effort: z.enum(EFFORTS) }).strict();

/** Every job exactly once, each on a model and effort its allowlist takes. */
export const modelPicksSchema = z
  .object(Object.fromEntries(MODEL_JOB_KEYS.map((key) => [key, modelPickSchema])) as Record<ModelJobKey, typeof modelPickSchema>)
  .strict()
  .superRefine((picks, ctx) => {
    for (const key of MODEL_JOB_KEYS) {
      const pick = picks[key];
      if (!isAllowed(key, pick.model, pick.effort)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "not allowed for this job" });
    }
  }) as unknown as z.ZodType<ModelPicks>;

export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,59}$/;

/** A job a reader moved off its pick (a model at its limit): the model it runs on instead, why, and since when. */
export const modelStatusSchema = z
  .object({
    model: z.string().regex(MODEL_ID_PATTERN),
    effort: z.enum(EFFORTS),
    reason: z.string().max(200),
    at: z.string().datetime(),
  })
  .strict();
export type ModelStatus = z.infer<typeof modelStatusSchema>;

export const modelsUpdatedSchema = z
  .object({ at: z.string().datetime(), by: z.string().max(100), action: z.string().max(100).optional() })
  .strict();
export type ModelsUpdated = z.infer<typeof modelsUpdatedSchema>;

/** The bridge's report of the Mac's picks file (null: none, or unreadable with fileError) and the readers' status file;
 * `readAt` (ms) is when the bridge read them, rising only within its process, which `run` names. */
export const modelReportSchema = z
  .object({
    run: z.string().max(100),
    readAt: z.number().int().positive().optional(),
    file: z
      .object({ jobs: z.record(z.string().max(40), z.unknown()).refine((jobs) => Object.keys(jobs).length <= 40, "too many jobs"), updated: modelsUpdatedSchema.optional() })
      .strict()
      .nullable(),
    fileError: z.string().max(300).optional(),
    status: z.record(z.enum(MODEL_JOB_KEYS), modelStatusSchema),
  })
  .strict();
export type ModelReport = z.infer<typeof modelReportSchema>;

export interface ModelSettingsResponse {
  jobs: readonly ModelJob[];
  /** The Mac file's picks, a job missing or invalid there on its default; null until the bridge has reported a file. */
  current: Record<ModelJobKey, ModelPick & { fromDefault?: true }> | null;
  updated: ModelsUpdated | null;
  /** Why the Mac could not read its picks file; while set, what it holds is not known. */
  fileError: string | null;
  status: Partial<Record<ModelJobKey, ModelStatus>>;
  reportedAt: string | null;
}

/** The picks a reported file holds, each job checked against its allowlist. */
export function picksFromFile(jobs: Record<string, unknown>): Record<ModelJobKey, ModelPick & { fromDefault?: true }> {
  return Object.fromEntries(
    MODEL_JOBS.map((job) => {
      const pick = modelPickSchema.safeParse(jobs[job.key]);
      return [job.key, pick.success && isAllowed(job.key, pick.data.model, pick.data.effort) ? pick.data : { ...defaultPick(job), fromDefault: true as const }];
    }),
  ) as Record<ModelJobKey, ModelPick & { fromDefault?: true }>;
}
