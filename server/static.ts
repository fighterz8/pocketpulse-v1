import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serve the Vite build output (`dist/public`) and fall back to `index.html` for client routing.
 * Unmatched `/api/*` requests already receive JSON 404 from `routes.ts` before this runs; the
 * `/api` check below is a safety net so SPA HTML is never sent for API paths.
 */
export function setupStatic(app: Express) {
  // Compiled to `dist/server/static.js`; Vite emits the SPA to `dist/public`.
  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(publicDir, "index.html"), (err) => {
      if (err) next(err);
    });
  });
}
