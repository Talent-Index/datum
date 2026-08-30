import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The suites are ports of the Python reference tests and, like them, run
    // entirely offline against committed fixtures.
    env: { DATA_OFFLINE: "1" },
    testTimeout: 30_000,
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
});
