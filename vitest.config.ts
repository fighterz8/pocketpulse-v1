import { defineConfig } from "vitest/config";

export default defineConfig({
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
        },
      },
    ],
  },
});
