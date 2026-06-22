/**
 * Ad-hoc maintenance runner for jobs that used to run implicitly at server
 * startup. Run intentionally before/after deploys instead of from serverless
 * request runtime.
 *
 * Usage: npx tsx server/maintenance-cli.ts
 * Or via package.json: npm run db:maintenance
 */
import {
  recoverStuckAiUploads,
  seedGlobalMerchantSeed,
  seedMerchantClassifications,
} from "./startup.js";

await seedGlobalMerchantSeed();
await seedMerchantClassifications();
await recoverStuckAiUploads();

console.log("[maintenance-cli] startup maintenance complete");
process.exit(0);
