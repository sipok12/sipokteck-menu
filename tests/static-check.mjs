// Vérifications statiques sans dépendance : syntaxe, imports/exports, clés i18n, identifiants HTML, scripts référencés.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const js = walk(join(root, 'js')).filter(f => f.endsWith('.js'));
const html = readdirSync(root).filter(f => f.endsWith('.html')).map(f => join(root, f));
const read = f => readFileSync(f, 'utf8');
const errors = [];

for (const f of js) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { errors.push(`syntaxe ${f}: ${e.stderr}`); } }

// imports nommés <-> exports
const exportsOf = f => {
  const s = read(f); const names = new Set();
  for (const m of s.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([\w$]+)/g)) names.add(m[1]);
  return names;
};
for (const f of js) {
  const s = read(f);
  for (const m of s.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = normalize(join(dirname(f), m[2]));
    if (!existsSync(target)) { errors.push(`${f}: fichier importé absent ${m[2]}`); continue; }
    const ex = exportsOf(target);
    for (const n of m[1].split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean))
      if (!ex.has(n)) errors.push(`${f}: '${n}' n'est pas exporté par ${m[2]}`);
  }
}

// clés i18n utilisées vs définies
const { fr } = await import('../js/locales/fr.js'); const { en } = await import('../js/locales/en.js');
const prefixes = 'a11y|act|hist|msg|trk|wa|auth|bill|cat|common|dash|err|feat|home|menu|method|nav|onb|ord|ov|pay|plans|prod|pstatus|qr|reset|set|status|tab|type';
const keyRe = new RegExp(`['"\`]((?:${prefixes})\\.[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*)['"\`]`, 'g');
const used = new Set();
for (const f of [...js.filter(x => !x.includes('/locales/')), ...html]) for (const m of read(f).matchAll(keyRe)) used.add(m[1]);
for (const k of used) { if (!(k in fr)) errors.push(`clé FR manquante: ${k}`); if (!(k in en)) errors.push(`clé EN manquante: ${k}`); }
for (const k of Object.keys(fr)) if (!(k in en)) errors.push(`clé absente en EN: ${k}`);
for (const k of Object.keys(en)) if (!(k in fr)) errors.push(`clé absente en FR: ${k}`);

// identifiants référencés par $('id') / getElementById
const defined = new Set();
for (const f of [...js, ...html]) for (const m of read(f).matchAll(/\bid=\\?["']([\w-]+)/g)) defined.add(m[1]);
for (const dyn of ['toasts', 'tab-overview']) defined.add(dyn); // créés dynamiquement (utils.toast, gabarit des onglets)
for (const f of js) for (const m of read(f).matchAll(/(?:\$|getElementById)\(\s*['"]([\w-]+)['"]/g))
  if (!defined.has(m[1])) errors.push(`${f}: id introuvable « ${m[1]} »`);

// scripts et feuilles de style référencés
for (const f of html) for (const m of read(f).matchAll(/(?:src|href)="(\/(?:js|css)\/[^"]+)"/g))
  if (!existsSync(join(root, m[1]))) errors.push(`${f}: ressource absente ${m[1]}`);

// la page publique du menu doit charger menu.css (classes product-grid, restaurant-hero… définies uniquement là)
if (!/href="\/css\/menu\.css"/.test(read(join(root, 'menu.html')))) errors.push('menu.html ne charge pas /css/menu.css');

// aucune bibliothèque externe : tout est empaqueté par Vite (CSP script-src 'self'), config.js servi depuis public/
for (const f of html) {
  for (const m of read(f).matchAll(/<script[^>]+src="(https?:[^"]+)"/g)) errors.push(`${f}: script externe interdit ${m[1]}`);
  if (!/<script src="\/config\.js"><\/script>/.test(read(f))) errors.push(`${f}: /config.js non chargé`);
}
if (!existsSync(join(root, 'public/config.js'))) errors.push('public/config.js absent');
if (/service_role/i.test(read(join(root, 'public/config.js')).replace(/\/\/.*$/gm, ''))) errors.push('public/config.js : service_role interdit');
if (/https:\/\/cdn/.test(read(join(root, 'vercel.json')))) errors.push('vercel.json : la CSP ne doit plus autoriser de CDN');

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`OK — ${js.length} modules, ${html.length} pages, ${used.size} clés i18n utilisées, ${Object.keys(fr).length} définies`);
