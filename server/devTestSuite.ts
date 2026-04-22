/**
 * Dev Test Suite — server route module (PR1: classification sampler + team view).
 *
 * All routes mounted here are gated by `requireDev`, which combines:
 *   1. DEV_MODE_ENABLED  (the hard off-switch from shared/devConfig)
 *   2. session auth      (must be logged in)
 *   3. users.isDev flag  (per-user opt-in)
 *
 * Any failure of those gates returns **404 Not Found** — the spec is explicit
 * (§7) that we must not signal the feature's existence with 403.
 *
 * Verdicts are sandboxed: nothing here writes back to the `transactions` table.
 */

import type { Request, RequestHandler, Router } from "express";
import { Router as createRouter } from "express";

import { DEV_MODE_ENABLED } from "../shared/devConfig.js";
import {
  CLASSIFICATION_CLASS_VALUES,
  CLASSIFICATION_RECURRENCE_VALUES,
  CLASSIFICATION_VERDICT_VALUES,
  V1_CATEGORIES,
  type ClassificationVerdict,
} from "../shared/schema.js";
import {
  completeClassificationSample,
  createClassificationSample,
  getClassificationSampleById,
  getLatestCompletedClassificationByUsers,
  getUserById,
  getUsersByIds,
  listClassificationSamplesForUser,
  pickClassificationSampleTransactions,
} from "./storage.js";

const V1_SET = new Set<string>(V1_CATEGORIES);
const CLASS_SET = new Set<string>(CLASSIFICATION_CLASS_VALUES);
const RECUR_SET = new Set<string>(CLASSIFICATION_RECURRENCE_VALUES);
const VERDICT_SET = new Set<string>(CLASSIFICATION_VERDICT_VALUES);

const NOT_FOUND_BODY = { error: "Not found" } as const;

/** Send the same opaque 404 the catchall sends — never reveal feature gating. */
function notFound(res: Parameters<RequestHandler>[1]): void {
  res.status(404).json(NOT_FOUND_BODY);
}

/**
 * Combined gate: DEV_MODE_ENABLED + session.userId + users.isDev = true.
 * Returns 404 (not 403) on any failure.
 */
export const requireDev: RequestHandler = async (req, res, next) => {
  try {
    if (!DEV_MODE_ENABLED) return notFound(res);
    const userId = req.session.userId;
    if (userId == null) return notFound(res);
    const user = await getUserById(userId);
    if (!user || user.isDev !== true) return notFound(res);
    next();
  } catch (e) {
    next(e);
  }
};

/** Parse DEV_TEAM_USER_IDS env var: comma-separated list of integers, ignoring junk. */
export function parseDevTeamUserIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

// ─── Validation ───────────────────────────────────────────────────────────────

function clampSampleSize(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(200, Math.max(1, Math.floor(n)));
}

type ValidatedVerdict = {
  ok: true;
  verdicts: ClassificationVerdict[];
  confirmed: number;
  corrected: number;
  skipped: number;
} | { ok: false; error: string };

/**
 * Validate the incoming verdicts payload against the original sample.
 *
 * Rules:
 *   - Every transactionId must belong to the original sample (anti-tamper)
 *   - `verdict` ∈ {confirmed, corrected, skipped}
 *   - When `verdict === "corrected"`, ≥1 corrected* field is non-null
 *   - Any non-null corrected value must be in its allowed set (V1_CATEGORIES /
 *     class values / recurrence values)
 */
function validateVerdicts(
  incoming: unknown,
  originalVerdicts: ClassificationVerdict[],
): ValidatedVerdict {
  if (!Array.isArray(incoming)) return { ok: false, error: "verdicts must be an array" };

  const byId = new Map<number, ClassificationVerdict>();
  for (const v of originalVerdicts) byId.set(v.transactionId, v);

  const out: ClassificationVerdict[] = [];
  let confirmed = 0;
  let corrected = 0;
  let skipped = 0;
  const seen = new Set<number>();

  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "verdict must be an object" };
    const r = raw as Record<string, unknown>;
    const tid = typeof r.transactionId === "number" ? r.transactionId : NaN;
    const original = byId.get(tid);
    if (!original) return { ok: false, error: `Unknown transactionId in verdicts: ${tid}` };
    if (seen.has(tid)) return { ok: false, error: `Duplicate verdict for transactionId ${tid}` };
    seen.add(tid);

    const verdict = String(r.verdict ?? "");
    if (!VERDICT_SET.has(verdict)) {
      return { ok: false, error: `Invalid verdict value: ${verdict}` };
    }

    let correctedCategory   = r.correctedCategory   == null ? null : String(r.correctedCategory);
    let correctedClass      = r.correctedClass      == null ? null : String(r.correctedClass);
    let correctedRecurrence = r.correctedRecurrence == null ? null : String(r.correctedRecurrence);

    if (verdict !== "corrected") {
      // Force null on non-corrected verdicts so the report math is unambiguous.
      correctedCategory = null;
      correctedClass = null;
      correctedRecurrence = null;
    } else {
      // At least one dimension must actually be corrected.
      if (correctedCategory == null && correctedClass == null && correctedRecurrence == null) {
        return { ok: false, error: `verdict=corrected but no corrected* field set (txn ${tid})` };
      }
      if (correctedCategory != null && !V1_SET.has(correctedCategory)) {
        return { ok: false, error: `Invalid correctedCategory: ${correctedCategory}` };
      }
      if (correctedClass != null && !CLASS_SET.has(correctedClass)) {
        return { ok: false, error: `Invalid correctedClass: ${correctedClass}` };
      }
      if (correctedRecurrence != null && !RECUR_SET.has(correctedRecurrence)) {
        return { ok: false, error: `Invalid correctedRecurrence: ${correctedRecurrence}` };
      }
    }

    if (verdict === "confirmed") confirmed++;
    else if (verdict === "corrected") corrected++;
    else skipped++;

    out.push({
      // Snapshot stays exactly as recorded at sample creation — never overwritten.
      transactionId: tid,
      classifierCategory:        original.classifierCategory,
      classifierClass:           original.classifierClass,
      classifierRecurrence:      original.classifierRecurrence,
      classifierLabelSource:     original.classifierLabelSource,
      classifierLabelConfidence: original.classifierLabelConfidence,
      verdict: verdict as ClassificationVerdict["verdict"],
      correctedCategory,
      correctedClass,
      correctedRecurrence,
    });
  }

  return { ok: true, verdicts: out, confirmed, corrected, skipped };
}

/** Per-dimension accuracy = (# non-skipped rows where the user did NOT correct that dim) / (# non-skipped). */
function dimensionAccuracy(
  verdicts: ClassificationVerdict[],
  correctedField: "correctedCategory" | "correctedClass" | "correctedRecurrence",
): number | null {
  const nonSkipped = verdicts.filter((v) => v.verdict !== "skipped");
  if (nonSkipped.length === 0) return null;
  const correct = nonSkipped.filter((v) => v[correctedField] == null).length;
  return correct / nonSkipped.length;
}

// ─── Helpers shared by JSON output ────────────────────────────────────────────

function sampleToJson(row: Awaited<ReturnType<typeof getClassificationSampleById>>) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    sampleSize: row.sampleSize,
    categoryAccuracy:   row.categoryAccuracy   != null ? parseFloat(String(row.categoryAccuracy))   : null,
    classAccuracy:      row.classAccuracy      != null ? parseFloat(String(row.classAccuracy))      : null,
    recurrenceAccuracy: row.recurrenceAccuracy != null ? parseFloat(String(row.recurrenceAccuracy)) : null,
    confirmedCount: row.confirmedCount,
    correctedCount: row.correctedCount,
    skippedCount:   row.skippedCount,
    verdicts: row.verdicts,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createDevTestSuiteRouter(): Router {
  const router = createRouter();

  // All dev routes share the requireDev gate.
  router.use(requireDev);

  // --- Classification sampler ----------------------------------------------

  /** POST /api/dev/classification-samples — start a new sample */
  router.post("/classification-samples", async (req: Request, res, next) => {
    try {
      const userId = req.session.userId!;
      const sampleSize = clampSampleSize(req.body?.sampleSize);

      const txns = await pickClassificationSampleTransactions(userId, sampleSize);
      if (txns.length === 0) {
        res.status(400).json({
          error: "No eligible transactions to sample. Upload some transactions first.",
        });
        return;
      }

      // Snapshot the classifier's view of every row right now so subsequent
      // reclassifies don't retroactively mutate the sample.
      const verdicts: ClassificationVerdict[] = txns.map((t) => ({
        transactionId: t.id,
        classifierCategory:        t.category,
        classifierClass:           t.transactionClass,
        classifierRecurrence:      t.recurrenceType,
        classifierLabelSource:     t.labelSource,
        classifierLabelConfidence: t.labelConfidence != null ? parseFloat(String(t.labelConfidence)) : 0,
        verdict: "skipped",
        correctedCategory: null,
        correctedClass: null,
        correctedRecurrence: null,
      }));

      const sample = await createClassificationSample({
        userId,
        sampleSize: txns.length,
        verdicts,
      });

      res.status(201).json({
        sampleId: sample.id,
        createdAt: sample.createdAt,
        sampleSize: sample.sampleSize,
        transactions: txns.map((t) => ({
          id: t.id,
          date: t.date,
          rawDescription: t.rawDescription,
          amount: parseFloat(String(t.amount)),
          category: t.category,
          transactionClass: t.transactionClass,
          recurrenceType: t.recurrenceType,
          labelSource: t.labelSource,
          labelConfidence: t.labelConfidence != null ? parseFloat(String(t.labelConfidence)) : 0,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/dev/classification-samples — list current user's samples */
  router.get("/classification-samples", async (req, res, next) => {
    try {
      const list = await listClassificationSamplesForUser(req.session.userId!);
      res.json({ samples: list });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/dev/classification-samples/:id — fetch one (own user's only) */
  router.get("/classification-samples/:id", async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id ?? "", 10);
      if (!Number.isFinite(id)) return notFound(res);
      const row = await getClassificationSampleById(id, req.session.userId!);
      if (!row) return notFound(res);
      res.json({ sample: sampleToJson(row) });
    } catch (e) {
      next(e);
    }
  });

  /** PATCH /api/dev/classification-samples/:id — submit verdicts */
  router.patch("/classification-samples/:id", async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id ?? "", 10);
      if (!Number.isFinite(id)) return notFound(res);
      const userId = req.session.userId!;

      const existing = await getClassificationSampleById(id, userId);
      if (!existing) return notFound(res);
      if (existing.completedAt != null) {
        res.status(409).json({ error: "Sample already submitted" });
        return;
      }

      const validated = validateVerdicts(req.body?.verdicts, existing.verdicts);
      if (!validated.ok) {
        res.status(400).json({ error: validated.error });
        return;
      }

      // Spec §4: at least 80% of the original sample must have a real verdict
      // before completion is allowed. Mirrors the frontend Submit gate so the
      // results table can never be salted with a one-row submission.
      const decided = validated.confirmed + validated.corrected + validated.skipped;
      const minDecided = Math.ceil(existing.sampleSize * 0.8);
      if (decided < minDecided) {
        res.status(400).json({
          error: `Need at least ${minDecided} of ${existing.sampleSize} verdicts to submit (got ${decided}).`,
        });
        return;
      }

      const updated = await completeClassificationSample({
        id,
        userId,
        verdicts: validated.verdicts,
        categoryAccuracy:   dimensionAccuracy(validated.verdicts, "correctedCategory"),
        classAccuracy:      dimensionAccuracy(validated.verdicts, "correctedClass"),
        recurrenceAccuracy: dimensionAccuracy(validated.verdicts, "correctedRecurrence"),
        confirmedCount: validated.confirmed,
        correctedCount: validated.corrected,
        skippedCount:   validated.skipped,
      });

      if (!updated) return notFound(res);
      res.json({ sample: sampleToJson(updated) });
    } catch (e) {
      next(e);
    }
  });

  // --- Team summary --------------------------------------------------------

  /** GET /api/dev/team-summary — latest completed sample per whitelisted teammate */
  router.get("/team-summary", async (_req, res, next) => {
    try {
      const ids = parseDevTeamUserIds(process.env.DEV_TEAM_USER_IDS);
      if (ids.length === 0) {
        res.status(400).json({
          error:
            "DEV_TEAM_USER_IDS is not configured. Add a comma-separated list of teammate user IDs to enable the team view.",
        });
        return;
      }

      const [users, samples] = await Promise.all([
        getUsersByIds(ids),
        getLatestCompletedClassificationByUsers(ids),
      ]);
      const userById = new Map(users.map((u) => [u.id, u]));

      const out = ids.map((userId) => {
        const u = userById.get(userId);
        const s = samples.get(userId);
        return {
          userId,
          email: u?.email ?? null,
          displayName: u?.displayName ?? null,
          classification: s
            ? {
                sampleId: s.id,
                completedAt: s.completedAt,
                sampleSize: s.sampleSize,
                categoryAccuracy:   s.categoryAccuracy   != null ? parseFloat(String(s.categoryAccuracy))   : null,
                classAccuracy:      s.classAccuracy      != null ? parseFloat(String(s.classAccuracy))      : null,
                recurrenceAccuracy: s.recurrenceAccuracy != null ? parseFloat(String(s.recurrenceAccuracy)) : null,
                confirmedCount: s.confirmedCount,
                correctedCount: s.correctedCount,
                skippedCount:   s.skippedCount,
              }
            : null,
          // Parser samples ship in PR2; field reserved so the client shape is stable.
          parser: null,
        };
      });

      res.json({ users: out });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// Exposed for tests
export const __testing = { validateVerdicts, dimensionAccuracy, parseDevTeamUserIds };
