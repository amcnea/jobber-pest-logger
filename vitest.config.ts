import { defineConfig } from "vitest/config";

// Pin the process timezone before any test worker starts so device-local date
// helpers (src/dates.ts) are deterministic in CI and on every dev machine.
// America/Chicago observes DST, which lets tests exercise DST boundaries.
process.env.TZ = "America/Chicago";

// Separate from vite.config.ts on purpose: unit tests don't need the React
// plugin or the GitHub Pages `base`, and Vitest prefers this file when present.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: { TZ: "America/Chicago" },
  },
});
