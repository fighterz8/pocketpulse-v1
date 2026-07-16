/**
 * Ad-hoc maintenance runner for jobs that used to run implicitly at server
 * startup. Run intentionally before/after deploys instead of from serverless
 * request runtime.
 *
 * Usage:
 *   npm run db:maintenance
 *   npm run ai:usage -- --from 2026-07-01 --to 2026-08-01 --userId 123
 */
import { parseAiUsageCliArgs } from "./aiUsageDiagnostics.js";
import { getAiUsageReport } from "./aiUsageQueries.js";
import {
  recoverStuckAiUploads,
  seedGlobalMerchantSeed,
  seedMerchantClassifications,
} from "./startup.js";

async function main(args: string[]): Promise<void> {
  const [command, ...commandArgs] = args;
  if (command === "ai-usage-summary") {
    const report = await getAiUsageReport(parseAiUsageCliArgs(commandArgs));
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command !== undefined && command !== "startup") {
    throw new RangeError(
      `unknown maintenance command: ${command}. Use startup or ai-usage-summary.`,
    );
  }

  await seedGlobalMerchantSeed();
  await seedMerchantClassifications();
  await recoverStuckAiUploads();
  console.log("[maintenance-cli] startup maintenance complete");
}

await main(process.argv.slice(2));
