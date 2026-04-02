import http from "node:http";

import { createApp } from "./routes.js";

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
