import { db } from "./db.js";
import { users } from "../shared/schema.js";
import {
  findStuckProcessingUploads,
  seedGlobalMerchantClassifications,
  seedMerchantClassificationsForUser,
  updateUploadAiStatus,
} from "./storage.js";
import { runUploadAiWorker } from "./aiWorker.js";

/**
 * Populate the global merchant seed table from RULE_SEED_ENTRIES (once per boot).
 * Uses onConflictDoNothing so repeat calls are safe and fast after the first run.
 */
export async function seedGlobalMerchantSeed(): Promise<void> {
  const inserted = await seedGlobalMerchantClassifications();
  console.log(`[startup] global merchant seed: ${inserted} new entries`);
}

/**
 * Seed the per-user merchant_classifications table from userCorrected rows.
 * Seeds only from rows where userCorrected=true or labelSource="manual".
 * Uses onConflictDoNothing so it is idempotent and safe on every startup.
 *
 * This is ongoing seed maintenance, not a schema migration — it runs on
 * every boot so that new user corrections are reflected in the cache.
 */
export async function seedMerchantClassifications(): Promise<void> {
  const allUsers = await db.select({ id: users.id }).from(users);
  let totalSeeded = 0;
  for (const u of allUsers) {
    totalSeeded += await seedMerchantClassificationsForUser(u.id);
  }
  console.log(
    `[startup] merchant classification seed complete (${totalSeeded} entries)`,
  );
}

/** Stuck-upload cutoff. An `ai_status='processing'` row whose
 * `ai_started_at` is older than this is considered abandoned (the worker
 * was killed mid-flight) and gets marked `failed` instead of being
 * resumed. Newer in-flight uploads are flipped back to `pending` and the
 * worker is re-kicked.
 */
const STUCK_UPLOAD_CUTOFF_MS = 60 * 60 * 1000; // 1 hour

/**
 * Restart-recovery sweep for the async AI worker.
 *
 * On a clean restart, any upload sitting in `ai_status='processing'` is
 * by definition orphaned — the in-process worker died with the previous
 * server instance. We split the orphans into two buckets:
 *
 *   • Older than 1h (or no `ai_started_at`) → mark as `failed` with a
 *     "server restart" error. The user keeps their rule/cache labels;
 *     they can manually trigger a reclassify if they want AI to retry.
 *   • Newer (started recently, killed by a quick restart) → flip back
 *     to `pending` and re-kick the worker. The worker is idempotent
 *     and only acts on rows still flagged `aiAssisted=true AND
 *     labelSource != 'ai'`, so re-runs cannot double-write.
 *
 * Safe to call before any HTTP traffic. Errors are logged but never
 * thrown — startup must succeed even if recovery fails.
 */
export async function recoverStuckAiUploads(): Promise<void> {
  let stuck: Awaited<ReturnType<typeof findStuckProcessingUploads>> = [];
  try {
    stuck = await findStuckProcessingUploads();
  } catch (err) {
    console.error(`[startup] recoverStuckAiUploads: lookup failed: ${err}`);
    return;
  }
  if (stuck.length === 0) {
    console.log(`[startup] AI worker recovery: no stuck uploads`);
    return;
  }

  const now = Date.now();
  let failed = 0;
  let rekicked = 0;

  for (const u of stuck) {
    const startedMs = u.aiStartedAt ? new Date(u.aiStartedAt).getTime() : null;
    const isExpired =
      startedMs == null || now - startedMs > STUCK_UPLOAD_CUTOFF_MS;

    try {
      if (isExpired) {
        await updateUploadAiStatus(u.id, {
          aiStatus: "failed",
          aiCompletedAt: new Date(),
          aiError: "AI worker interrupted by server restart",
        });
        failed++;
      } else {
        await updateUploadAiStatus(u.id, {
          aiStatus: "pending",
          aiStartedAt: null,
          aiError: null,
        });
        // Re-kick the worker — fire-and-forget so the rest of the sweep
        // (and the rest of startup) can proceed in parallel.
        void runUploadAiWorker(u.userId, u.id).catch((err) => {
          console.error(
            `[aiWorker] recovery re-kick failed for upload=${u.id}: ${err}`,
          );
        });
        rekicked++;
      }
    } catch (err) {
      console.error(
        `[startup] recoverStuckAiUploads: update failed for upload=${u.id}: ${err}`,
      );
    }
  }

  console.log(
    `[startup] AI worker recovery: ${failed} marked failed, ${rekicked} re-kicked`,
  );
}
