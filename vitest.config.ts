import { defineConfig } from "vitest/config";

// Pure-function unit tests only — no DOM, so no jsdom/global setup yet.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
