import { defineConfig } from 'vite';

// Relative base: assets resolve from wherever the page is served, so the
// project-pages path (/ping-pong/) works and extra HTML pages added later
// resolve correctly. `npm run dev` still serves at `/`.
export default defineConfig({
  base: './',
});
