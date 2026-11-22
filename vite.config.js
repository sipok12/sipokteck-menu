import { defineConfig } from 'vite';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = import.meta.dirname;
// Chaque page HTML à la racine est un point d'entrée (site multi-pages, sans framework).
const pages = Object.fromEntries(
  readdirSync(root).filter(f => f.endsWith('.html')).map(f => [f.replace(/\.html$/, ''), resolve(root, f)])
);

// En développement, reproduit « cleanUrls » de Vercel : /dashboard -> /dashboard.html
const cleanUrls = {
  name: 'sipokmenu-clean-urls',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const [path, query = ''] = (req.url || '').split('?');
      if (/^\/[a-z-]+$/.test(path) && pages[path.slice(1)]) req.url = `${path}.html${query ? `?${query}` : ''}`;
      next();
    });
  }
};

export default defineConfig({
  appType: 'mpa',
  publicDir: 'public', // config.js (URL + clé publishable + paiement) reste modifiable sans rebuild
  plugins: [cleanUrls],
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: pages } }
});
