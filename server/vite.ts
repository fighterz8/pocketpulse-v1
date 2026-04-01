import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { createServer as createViteServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.join(__dirname, "..");

/**
 * Attach Vite dev middleware (same Node process as Express). `/api/*` is handled by Express route
 * handlers registered before this; only non-API traffic reaches Vite. For the split-dev setup
 * (browser → Vite on 5000), `/api` is proxied to this server by `vite.config.ts`, not here.
 */
export async function setupVite(app: Express, server: http.Server) {
  const vite = await createViteServer({
    configFile: path.join(workspaceRoot, "vite.config.ts"),
    server: {
      middlewareMode: true,
      hmr: { server },
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
