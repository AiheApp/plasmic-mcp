import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Load .env so the live read smoke (read.smoke.test.ts) can run from local config.
    setupFiles: ["dotenv/config"],
  },
});
