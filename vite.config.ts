import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, "client"),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    strictPort: true,
    allowedHosts: [
      "62a59de6-74f8-4147-b39b-eaa0464852fd-00-1zih0nm80aas8.worf.replit.dev",
    ],
    // Used only by `npm run dev:vite`; default `npm run dev` serves API + Vite on `PORT` (5000).
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_PORT ?? "5001"}`,
        changeOrigin: true,
      },
    },
  },
});
