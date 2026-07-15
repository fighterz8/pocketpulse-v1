import { db } from "./db.js";
import { users } from "../shared/schema.js";
import {
  findStuckProcessingUploads,
  seedGlobalMerchantClassifications,
  seedMerchantClassificationsForUser,
  updateUploadAiStatus,
} from "./storage.js";

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

/**
 * Retire orphaned legacy automatic-enhancement states without re-kicking a
 * paid worker. The explicit, budgeted job system introduced in later slices
 * will own its own durable recovery semantics.
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

  let retired = 0;

  for (const u of stuck) {
    try {
      await updateUploadAiStatus(u.id, {
        aiStatus: "none",
        aiRowsPending: 0,
        aiRowsDone: 0,
        aiStartedAt: null,
        aiCompletedAt: null,
        aiError: null,
      });
      retired++;
    } catch (err) {
      console.error(
        `[startup] recoverStuckAiUploads: update failed for upload=${u.id}: ${err}`,
      );
    }
  }

  console.log(
    `[startup] legacy AI worker recovery: ${retired} states retired, 0 workers started`,
  );
}
