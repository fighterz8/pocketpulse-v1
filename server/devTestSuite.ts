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
  PARSER_AMOUNT_VERDICTS,
  PARSER_DATE_VERDICTS,
  PARSER_DESC_VERDICTS,
  PARSER_DIRECTION_VERDICTS,
  V1_CATEGORIES,
  type ClassificationVerdict,
  type ParserVerdict,
} from "../shared/schema.js";
import {
  completeClassificationSample,
  completeParserSample,
  createClassificationSample,
  createParserSample,
  getClassificationSampleById,
  getLatestCompletedClassificationByUsers,
  getParserSampleById,
  getTransactionDisplayByIds,
  getUserById,
  getUsersByIds,
  getLatestCompletedParserByUsers,
  listClassificationSamplesForUser,
  listParserSamplesForUser,
  pickClassificationSampleTransactions,
  pickParserSampleTransactions,
  resolveParserSampleUpload,
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

// ─── Parser fidelity (PR2) ────────────────────────────────────────────────────

const PARSER_DATE_SET   = new Set<string>(PARSER_DATE_VERDICTS);
const PARSER_DESC_SET   = new Set<string>(PARSER_DESC_VERDICTS);
const PARSER_AMOUNT_SET = new Set<string>(PARSER_AMOUNT_VERDICTS);
const PARSER_DIR_SET    = new Set<string>(PARSER_DIRECTION_VERDICTS);

/**
 * Reconstruct a "raw CSV row" from stored fields. Display-only (per spec §6
 * Option 2) — never persisted back to the transactions table.
 *
 * The "raw" amount is the *absolute* value: signing it from `flowType` would
 * leak the parser's direction interpretation into the reference view and
 * defeat the purpose of letting reviewers catch sign-flip bugs. The parsed
 * column shows the signed amount + flowType pill separately.
 */
function reconstructRawRow(t: {
  date: string;
  rawDescription: string;
  amount: string;
}): { rawDate: string; rawDescription: string; rawAmount: string } {
  const abs = Math.abs(parseFloat(String(t.amount)));
  return {
    rawDate: t.date,
    rawDescription: t.rawDescription,
    rawAmount: abs.toFixed(2),
  };
}

type ValidatedParserVerdicts =
  | { ok: true; verdicts: ParserVerdict[]; confirmed: number; flagged: number }
  | { ok: false; error: string };

/**
 * Validate parser verdict payloads against the original sample's snapshot.
 * Same anti-tamper posture as the classification validator: only known
 * transactionIds, only allowed enum values, snapshots are never overwritten.
 */
function validateParserVerdicts(
  incoming: unknown,
  original: ParserVerdict[],
): ValidatedParserVerdicts {
  if (!Array.isArray(incoming)) return { ok: false, error: "verdicts must be an array" };
  const byId = new Map<number, ParserVerdict>();
  for (const v of original) byId.set(v.transactionId, v);

  const out: ParserVerdict[] = [];
  let confirmed = 0;
  let flagged = 0;
  const seen = new Set<number>();

  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "verdict must be an object" };
    const r = raw as Record<string, unknown>;
    const tid = typeof r.transactionId === "number" ? r.transactionId : NaN;
    const orig = byId.get(tid);
    if (!orig) return { ok: false, error: `Unknown transactionId in verdicts: ${tid}` };
    if (seen.has(tid)) return { ok: false, error: `Duplicate verdict for transactionId ${tid}` };
    seen.add(tid);

    const skipped = r.skipped === true;
    let dateV = String(r.dateVerdict ?? "ok");
    let descV = String(r.descriptionVerdict ?? "ok");
    let amtV  = String(r.amountVerdict ?? "ok");
    let dirV  = String(r.directionVerdict ?? "ok");

    if (skipped) {
      // Force per-field verdicts to "ok" for skipped rows so they don't pollute
      // the wrong-* counts (they're already excluded from accuracy denominators).
      dateV = "ok"; descV = "ok"; amtV = "ok"; dirV = "ok";
    } else {
      if (!PARSER_DATE_SET.has(dateV))   return { ok: false, error: `Invalid dateVerdict: ${dateV}` };
      if (!PARSER_DESC_SET.has(descV))   return { ok: false, error: `Invalid descriptionVerdict: ${descV}` };
      if (!PARSER_AMOUNT_SET.has(amtV))  return { ok: false, error: `Invalid amountVerdict: ${amtV}` };
      if (!PARSER_DIR_SET.has(dirV))     return { ok: false, error: `Invalid directionVerdict: ${dirV}` };
    }

    const allOk = dateV === "ok" && descV === "ok" && amtV === "ok" && dirV === "ok";
    if (skipped) {
      // Skipped rows count as neither confirmed nor flagged — they're tracked
      // implicitly as (sampleSize - confirmed - flagged).
    } else if (allOk) {
      confirmed++;
    } else {
      flagged++;
    }

    const notes = r.notes == null ? null : String(r.notes).slice(0, 500);

    out.push({
      transactionId: tid,
      // Snapshots are never overwritten by client input.
      rawDate:           orig.rawDate,
      rawDescription:    orig.rawDescription,
      rawAmount:         orig.rawAmount,
      parsedDate:        orig.parsedDate,
      parsedDescription: orig.parsedDescription,
      parsedAmount:      orig.parsedAmount,
      parsedFlowType:    orig.parsedFlowType,
      parsedAmbiguous:   orig.parsedAmbiguous,
      skipped,
      dateVerdict:        dateV as ParserVerdict["dateVerdict"],
      descriptionVerdict: descV as ParserVerdict["descriptionVerdict"],
      amountVerdict:      amtV  as ParserVerdict["amountVerdict"],
      directionVerdict:   dirV  as ParserVerdict["directionVerdict"],
      notes,
    });
  }

  return { ok: true, verdicts: out, confirmed, flagged };
}

/** Per-field accuracy = (# non-skipped rows where field === "ok") / (# non-skipped). */
function parserFieldAccuracy(
  verdicts: ParserVerdict[],
  field: "dateVerdict" | "descriptionVerdict" | "amountVerdict" | "directionVerdict",
): number | null {
  const nonSkipped = verdicts.filter((v) => !v.skipped);
  if (nonSkipped.length === 0) return null;
  const ok = nonSkipped.filter((v) => v[field] === "ok").length;
  return ok / nonSkipped.length;
}

function parserSampleToJson(
  row: Awaited<ReturnType<typeof getParserSampleById>>,
  uploadDate: Date | string | null = null,
) {
  if (!row) return null;
  return {
    id: row.id,
    uploadId: row.uploadId,
    uploadDate: uploadDate instanceof Date ? uploadDate.toISOString() : uploadDate,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    sampleSize: row.sampleSize,
    dateAccuracy:        row.dateAccuracy        != null ? parseFloat(String(row.dateAccuracy))        : null,
    descriptionAccuracy: row.descriptionAccuracy != null ? parseFloat(String(row.descriptionAccuracy)) : null,
    amountAccuracy:      row.amountAccuracy      != null ? parseFloat(String(row.amountAccuracy))      : null,
    directionAccuracy:   row.directionAccuracy   != null ? parseFloat(String(row.directionAccuracy))   : null,
    uploadRowCount:     row.uploadRowCount,
    uploadWarningCount: row.uploadWarningCount,
    confirmedCount: row.confirmedCount,
    flaggedCount:   row.flaggedCount,
    verdicts: row.verdicts,
  };
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
      const userId = req.session.userId!;
      const row = await getClassificationSampleById(id, userId);
      if (!row) return notFound(res);

      // Re-hydrate Ledger context (date / description / amount) for each sampled
      // transaction so an in-progress sample reopened from a URL has the same
      // review-screen experience as one created in the current session.
      const txnIds = row.verdicts.map((v) => v.transactionId);
      const display = await getTransactionDisplayByIds(txnIds, userId);
      const transactions = row.verdicts.map((v) => {
        const d = display.get(v.transactionId);
        return {
          id: v.transactionId,
          // If the underlying transaction was deleted (rare but possible),
          // fall back to a placeholder so the UI still renders.
          date: d?.date ?? "(unavailable)",
          rawDescription: d?.rawDescription ?? `Transaction #${v.transactionId} (deleted)`,
          amount: d ? parseFloat(String(d.amount)) : 0,
          category: v.classifierCategory,
          transactionClass: v.classifierClass,
          recurrenceType: v.classifierRecurrence,
          labelSource: v.classifierLabelSource,
          labelConfidence: v.classifierLabelConfidence,
        };
      });

      res.json({ sample: sampleToJson(row), transactions });
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

      // Spec §4: at least 80% of the original sample must have an explicit
      // verdict (confirmed / corrected / skipped) before completion. Mirrors
      // the frontend Submit gate so the metrics table can never be salted
      // with a one-row submission.
      const decidedFromClient = validated.verdicts.length;
      const minDecided = Math.ceil(existing.sampleSize * 0.8);
      if (decidedFromClient < minDecided) {
        res.status(400).json({
          error: `Need at least ${minDecided} of ${existing.sampleSize} verdicts to submit (got ${decidedFromClient}).`,
        });
        return;
      }

      // Merge submitted verdicts into the original snapshot so omitted rows
      // remain represented (with their original "skipped" default + classifier
      // snapshot intact). This preserves the full sample for the metrics table
      // and prevents a partial submission from rewriting the persisted row set.
      const incomingById = new Map(validated.verdicts.map((v) => [v.transactionId, v]));
      const merged: ClassificationVerdict[] = existing.verdicts.map((orig) =>
        incomingById.get(orig.transactionId) ?? orig,
      );

      // Recount over the merged set so confirmed/corrected/skipped counts and
      // the per-dimension accuracy denominators match what's actually stored.
      let confirmed = 0;
      let corrected = 0;
      let skipped = 0;
      for (const v of merged) {
        if (v.verdict === "confirmed") confirmed++;
        else if (v.verdict === "corrected") corrected++;
        else skipped++;
      }

      const updated = await completeClassificationSample({
        id,
        userId,
        verdicts: merged,
        categoryAccuracy:   dimensionAccuracy(merged, "correctedCategory"),
        classAccuracy:      dimensionAccuracy(merged, "correctedClass"),
        recurrenceAccuracy: dimensionAccuracy(merged, "correctedRecurrence"),
        confirmedCount: confirmed,
        correctedCount: corrected,
        skippedCount:   skipped,
      });

      if (!updated) return notFound(res);
      res.json({ sample: sampleToJson(updated) });
    } catch (e) {
      next(e);
    }
  });

  // --- Parser fidelity sampler (PR2) ---------------------------------------

  /** POST /api/dev/parser-samples — start a new parser sample */
  router.post("/parser-samples", async (req: Request, res, next) => {
    try {
      const userId = req.session.userId!;
      const sampleSize = clampSampleSize(req.body?.sampleSize);
      const explicitUploadId =
        req.body?.uploadId == null ? null :
        (typeof req.body.uploadId === "number" ? req.body.uploadId :
          Number.parseInt(String(req.body.uploadId), 10));

      const upload = await resolveParserSampleUpload(
        userId,
        Number.isFinite(explicitUploadId) ? explicitUploadId as number : null,
      );
      if (!upload) {
        res.status(400).json({
          error: explicitUploadId != null
            ? "Upload not found, or it does not belong to you."
            : "No completed upload found. Upload a CSV first.",
        });
        return;
      }

      const txns = await pickParserSampleTransactions(userId, upload.id, sampleSize);
      if (txns.length === 0) {
        res.status(400).json({
          error: "No eligible transactions in that upload to sample.",
        });
        return;
      }

      // Snapshot raw + parsed view of every row at sample creation. The "raw"
      // side is reconstructed from stored fields (display-only, never persisted
      // back). Parsed side reflects what the parser produced for that row.
      const verdicts: ParserVerdict[] = txns.map((t) => {
        const raw = reconstructRawRow(t);
        return {
          transactionId: t.id,
          rawDate: raw.rawDate,
          rawDescription: raw.rawDescription,
          rawAmount: raw.rawAmount,
          parsedDate: t.date,
          parsedDescription: t.rawDescription,
          parsedAmount: parseFloat(String(t.amount)),
          parsedFlowType: t.flowType,
          // spec §6: ambiguous flag isn't persisted — derive from aiAssisted
          // (the only signal we have that the parser/classifier reached for AI
          // because rule-based extraction was uncertain).
          parsedAmbiguous: !!t.aiAssisted,
          skipped: false,
          dateVerdict: "ok",
          descriptionVerdict: "ok",
          amountVerdict: "ok",
          directionVerdict: "ok",
          notes: null,
        };
      });

      const sample = await createParserSample({
        userId,
        uploadId: upload.id,
        sampleSize: txns.length,
        uploadRowCount: upload.rowCount,
        uploadWarningCount: upload.warningCount,
        verdicts,
      });

      res.status(201).json({
        sampleId: sample.id,
        uploadId: upload.id,
        uploadDate: upload.uploadedAt instanceof Date
          ? upload.uploadedAt.toISOString()
          : upload.uploadedAt,
        createdAt: sample.createdAt,
        sampleSize: sample.sampleSize,
        uploadRowCount: upload.rowCount,
        uploadWarningCount: upload.warningCount,
        verdicts,
      });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/dev/parser-samples — list current user's parser samples */
  router.get("/parser-samples", async (req, res, next) => {
    try {
      const list = await listParserSamplesForUser(req.session.userId!);
      res.json({ samples: list });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/dev/parser-samples/:id — fetch one (own user's only) */
  router.get("/parser-samples/:id", async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id ?? "", 10);
      if (!Number.isFinite(id)) return notFound(res);
      const userId = req.session.userId!;
      const row = await getParserSampleById(id, userId);
      if (!row) return notFound(res);
      // Snapshot uploadedAt at read time so the report can show "from upload
      // X on <date>" with a stable per-user link to the existing warnings UI.
      const upload = row.uploadId != null
        ? await resolveParserSampleUpload(userId, row.uploadId)
        : null;
      res.json({ sample: parserSampleToJson(row, upload?.uploadedAt ?? null) });
    } catch (e) {
      next(e);
    }
  });

  /** PATCH /api/dev/parser-samples/:id — submit verdicts */
  router.patch("/parser-samples/:id", async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id ?? "", 10);
      if (!Number.isFinite(id)) return notFound(res);
      const userId = req.session.userId!;

      const existing = await getParserSampleById(id, userId);
      if (!existing) return notFound(res);
      if (existing.completedAt != null) {
        res.status(409).json({ error: "Sample already submitted" });
        return;
      }

      const validated = validateParserVerdicts(req.body?.verdicts, existing.verdicts);
      if (!validated.ok) {
        res.status(400).json({ error: validated.error });
        return;
      }

      // Same ≥80% gate as the classification sampler (spec §4) so the metrics
      // table can never be salted with a one-row submission.
      const decided = validated.verdicts.length;
      const minDecided = Math.ceil(existing.sampleSize * 0.8);
      if (decided < minDecided) {
        res.status(400).json({
          error: `Need at least ${minDecided} of ${existing.sampleSize} verdicts to submit (got ${decided}).`,
        });
        return;
      }

      // Merge into the original snapshot so omitted rows keep their default
      // (skipped=false, all "ok") and the persisted set always equals sampleSize.
      const incomingById = new Map(validated.verdicts.map((v) => [v.transactionId, v]));
      const merged: ParserVerdict[] = existing.verdicts.map((orig) =>
        incomingById.get(orig.transactionId) ?? orig,
      );

      // Recount over the merged set so confirmed/flagged match what's stored.
      let confirmed = 0;
      let flagged = 0;
      for (const v of merged) {
        if (v.skipped) continue;
        const allOk = v.dateVerdict === "ok" && v.descriptionVerdict === "ok"
          && v.amountVerdict === "ok" && v.directionVerdict === "ok";
        if (allOk) confirmed++;
        else flagged++;
      }

      const updated = await completeParserSample({
        id,
        userId,
        verdicts: merged,
        dateAccuracy:        parserFieldAccuracy(merged, "dateVerdict"),
        descriptionAccuracy: parserFieldAccuracy(merged, "descriptionVerdict"),
        amountAccuracy:      parserFieldAccuracy(merged, "amountVerdict"),
        directionAccuracy:   parserFieldAccuracy(merged, "directionVerdict"),
        confirmedCount: confirmed,
        flaggedCount:   flagged,
      });

      if (!updated) return notFound(res);
      const upload = updated.uploadId != null
        ? await resolveParserSampleUpload(userId, updated.uploadId)
        : null;
      res.json({ sample: parserSampleToJson(updated, upload?.uploadedAt ?? null) });
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

      const [users, samples, parsers] = await Promise.all([
        getUsersByIds(ids),
        getLatestCompletedClassificationByUsers(ids),
        getLatestCompletedParserByUsers(ids),
      ]);
      const userById = new Map(users.map((u) => [u.id, u]));

      const out = ids.map((userId) => {
        const u = userById.get(userId);
        const s = samples.get(userId);
        const p = parsers.get(userId);
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
          parser: p
            ? {
                sampleId: p.id,
                completedAt: p.completedAt,
                sampleSize: p.sampleSize,
                dateAccuracy:        p.dateAccuracy        != null ? parseFloat(String(p.dateAccuracy))        : null,
                descriptionAccuracy: p.descriptionAccuracy != null ? parseFloat(String(p.descriptionAccuracy)) : null,
                amountAccuracy:      p.amountAccuracy      != null ? parseFloat(String(p.amountAccuracy))      : null,
                directionAccuracy:   p.directionAccuracy   != null ? parseFloat(String(p.directionAccuracy))   : null,
                confirmedCount: p.confirmedCount,
                flaggedCount:   p.flaggedCount,
                uploadRowCount:     p.uploadRowCount,
                uploadWarningCount: p.uploadWarningCount,
              }
            : null,
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
