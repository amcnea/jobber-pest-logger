import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pages project site (see feat/github-pages-host / /jobber-pest-logger/).
  base: "/jobber-pest-logger/",
  plugins: [react()],
});
