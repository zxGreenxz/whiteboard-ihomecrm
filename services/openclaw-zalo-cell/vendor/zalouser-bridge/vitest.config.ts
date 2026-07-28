import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["upstream/**", "licenses/**", "artifacts/**", ".work/**", "node_modules/**"],
    fileParallelism: false,
    hookTimeout: 180_000,
    include: ["test/**/*.test.ts"],
    isolate: true,
    pool: "forks",
    testTimeout: 180_000,
  },
});
