import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          include: ["server/**/*.{test,spec}.ts"],
        },
      },
      {
        test: {
          name: "client",
          environment: "jsdom",
          include: ["client/**/*.{test,spec}.{ts,tsx}"],
          setupFiles: ["./client/src/test/setup.ts"],
        },
      },
    ],
  },
});
