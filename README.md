# SipokMenu

Plateforme SaaS de menus digitaux et de commandes pour restaurants, maquis, cafés et fast-foods (Togo, FCFA).
Les clients consultent le menu via un QR code **sans compte** ; les restaurateurs gèrent menu, commandes et abonnement ;
l'administration valide les restaurants et les paiements.

## Stack (celle réellement déployée)
HTML / CSS / JavaScript vanilla (modules ES) · **Vite** (build multi-pages) · Supabase (PostgreSQL, Auth, Storage, Realtime) · Vercel · Chart.js · qrcode (QR) · polices Bricolage Grotesque + Figtree (npm).
Bibliothèques installées via npm à version exacte et empaquetées : plus aucun CDN, CSP `script-src 'self'`.
Langues : français et anglais. Devise : FCFA (XOF).

> Bootstrap 5 : non adopté (décision : conserver le CSS existant pour éviter une réécriture visuelle). Vite a été ajouté sans toucher aux services ni à la base.

## Structure
```
index.html dashboard.html menu.html qr.html admin.html reset.html   pages
public/config.js          URL + clé publishable Supabase + coordonnées de paiement (public, copié tel quel dans dist/)
vite.config.js            build multi-pages + URLs propres en dev
css/                      styles.css, menu.css (existants) · app.css (composants communs)
js/core/                  supabase, utils, i18n, errors, auth, modal
js/services/              restaurant, catalog, orders, billing, storage, admin  (accès Supabase)
js/dashboard/             un module par onglet : overview, orders, products, categories, billing, settings, onboarding
js/pages/                 point d'entrée de chaque page
js/locales/               fr.js, en.js (321 clés, parité vérifiée)
supabase/migrations/      migrations appliquées en production (A → C)
tests/                    unit.test.mjs (16 tests) · static-check.mjs
docs/                     ARCHITECTURE.md · DEPLOY.md · TESTING.md
```

## Démarrage
```bash
npm install
npm run dev         # serveur Vite (http://localhost:5173, URLs propres /dashboard, /menu…)
npm test            # 16 tests unitaires
npm run check       # syntaxe, imports, clés i18n, identifiants HTML, aucun script externe
npm run build       # génère dist/
npm run verify      # test + check + build
```
Configuration : `public/config.js` (clé **publishable** uniquement — jamais de `service_role`). Voir `docs/DEPLOY.md`.

## Offres
Starter 2 500 F · Business 5 000 F · Premium 8 000 F par mois (valeurs lues dans la table `plans`, modifiables par l'admin).
Paiement manuel : le restaurateur envoie une demande (référence et/ou justificatif), l'admin la valide. Quotas produits/catégories et
statistiques sont appliqués **côté base** selon l'offre active (Starter par défaut pendant l'essai).

## Sécurité en bref
RLS sur toutes les tables · colonnes sensibles protégées par triggers et droits colonne · prix et totaux recalculés par le serveur ·
RPC admin en `SECURITY DEFINER` avec contrôle explicite du rôle · justificatifs dans un bucket privé (liens signés 10 min) ·
CSP et en-têtes de sécurité (`vercel.json`) · bibliothèques CDN à version exacte. Détails : `docs/ARCHITECTURE.md`.

## Limites connues
- Les scripts de pages (DOM) n'ont pas pu être exécutés dans un navigateur par l'auteur de cette version : ils sont vérifiés statiquement
  et leur logique métier par tests, mais `docs/TESTING.md` (parcours manuel) doit être déroulé avant mise en production.
- Pas encore de gestion d'équipe (invitation du personnel) ni de notifications e-mail/SMS.
