/**
 * Vitest setup (all test files). Keeps node-environment tests unchanged:
 * - Registers @testing-library/jest-dom matchers on Vitest's `expect` (and their
 *   TypeScript types, via the `/vitest` entry) — harmless in node files.
 * - Unmounts React Testing Library renders after each test, only in DOM
 *   environments (files opted in with `// @vitest-environment jsdom`).
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
