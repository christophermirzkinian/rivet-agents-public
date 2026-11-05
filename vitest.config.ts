import { defineConfig } from "vitest/config";

// vite.config.ts roots Vite at web/, so tests need their own root.
export default defineConfig({
  test: {
    // The shared per-test event-loop yield.
    setupFiles: ["./vitest.setup.ts"],
    root: ".",
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Server, socket and full-yard tests take 1-4 s on a quiet Mac and pass the 5 s
    // default on a busy CI runner.
    testTimeout: 30_000,
  },
});
