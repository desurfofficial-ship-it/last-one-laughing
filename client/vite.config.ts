import { defineConfig } from 'vite';

// base './' keeps the production bundle relocatable: it works on GitHub Pages
// project sites, any subdirectory, or a static file server without rewrites.
export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
  },
});
