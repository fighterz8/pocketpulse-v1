import http from "node:http";

import { createApp } from "./routes.js";
import { runMigrations } from "./migrations.js";
import {
  recoverStuckAiUploads,
  seedGlobalMerchantSeed,
  seedMerchantClassifications,
} from "./startup.js";

// Apply any pending Drizzle migrations before the server accepts traffic.
// Idempotent — already-applied migrations are skipped automatically.
await runMigrations();
console.log("[startup] migrations applied");

// Populate the global merchant seed table (RULE_SEED_ENTRIES → DB).
// onConflictDoNothing makes this idempotent on every restart.
try {
  await seedGlobalMerchantSeed();
} catch (err) {
  console.warn("[startup] global merchant seed skipped:", err);
}

// Seed the per-user merchant classification cache from user-corrected rows.
// Runs every boot to pick up corrections made since the last restart.
try {
  await seedMerchantClassifications();
} catch (err) {
  console.warn("[startup] merchant classification seed skipped:", err);
}

// Restart-recovery for the async AI worker: anything orphaned in
// ai_status='processing' OR 'pending' (no live worker because the prior
// process died) is either re-kicked (recent) or marked failed (older
// than 1h). Idempotent and self-contained — never throws.
try {
  await recoverStuckAiUploads();
} catch (err) {
  console.warn("[startup] AI worker recovery skipped:", err);
}

if (!process.env.BETA_ACCESS_CODE) {
  console.warn(
    "[startup] BETA_ACCESS_CODE is not set — the Coming Soon beta gate will reject every code. Set it in Replit Secrets to enable beta access.",
  );
}

const app = createApp();
const isProduction = process.env.NODE_ENV === "production";
/**
 * Dev: defaults to 5001 (API-only, Vite runs separately on 5000 and proxies /api here).
 * Prod: uses PORT from environment (Replit maps external 80 → 5000).
 */
const port = Number(process.env.PORT ?? (isProduction ? "5000" : "5001"));
const server = http.createServer(app);

if (isProduction) {
  const { setupStatic } = await import("./static.js");
  setupStatic(app);
} else if (!process.env.SKIP_VITE) {
  const { setupVite } = await import("./vite.js");
  await setupVite(app, server);
}

server.listen(port, "0.0.0.0", () => {
  console.log(`server listening on ${port}`);
});
