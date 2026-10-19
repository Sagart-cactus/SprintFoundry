import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/bootstrap.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        statements: 55,
        branches: 30,
        functions: 55,
        lines: 55,
      },
    },
  },
});
