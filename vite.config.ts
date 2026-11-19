/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

// Relative base: assets resolve from wherever the page is served, so the
// project-pages path (/ping-pong/) works and extra HTML pages added later
// resolve correctly. `npm run dev` still serves at `/`.
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      // The game plus the latency harness page (dist/latency.html, not linked from the game).
      input: { main: resolve(import.meta.dirname, 'index.html'), latency: resolve(import.meta.dirname, 'latency.html') },
    },
  },
  test: {
    // Agent worktrees live under .claude/; never pick up their tests.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
