// @ts-check
import { defineConfig } from 'astro/config';

// GitHub *project* page hosting (decision D2 = project page):
//   published at  https://<user>.github.io/fault-hazard-explorer/
// If you later move to a subdomain (e.g. hazard.jameslagreca.com), set
//   base: '/'  and  site: 'https://hazard.jameslagreca.com'
// and drop the base-path handling — that's the only place it leaks.
export default defineConfig({
  site: 'https://james-lagreca.github.io',
  base: '/fault-hazard-explorer/',
  trailingSlash: 'ignore',
  build: { assets: '_assets' },
  vite: {
    // plotly ships a large pre-bundled file; keep it out of the warning noise.
    build: { chunkSizeWarningLimit: 4000 },
  },
});
