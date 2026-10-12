import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    // Parallel DOM environments exhausted this Intel Mac's resources; the same
    // tests pass with one worker. Product deadlines use fake timers separately.
    maxWorkers: 1,
    // Cold DOM/accessibility work took up to 18s on this host; this is a test
    // wall-clock budget, not an extension to the fake-timed editor deadlines.
    testTimeout: 30_000,
  },
});
