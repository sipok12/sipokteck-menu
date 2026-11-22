# Déploiement et configuration

## 1. Supabase (projet `ydhumfbcnhydgtxuzuhb`)
Les migrations de `supabase/migrations/` (001 → 004) sont **déjà appliquées** en production. Pour un nouvel environnement : appliquer d'abord le schéma de base
(non versionné dans ce dépôt : `supabase db dump --schema public,private` depuis la production), puis les 4 migrations dans l'ordre.

**Réglages à faire dans le tableau de bord (non automatisables ici) :**
- *Authentication → URL Configuration* : **Site URL** = votre domaine de production ; **Redirect URLs** : `https://<domaine>/dashboard` et `https://<domaine>/reset`
  (sans cela, la confirmation d'e-mail et la réinitialisation du mot de passe échouent).
- *Authentication → Providers → Email* : activer la **protection contre les mots de passe compromis** (alerte officielle Supabase) et fixer la longueur minimale à 8.
- *Authentication → SMTP* : configurer un SMTP personnalisé (l'envoi par défaut de Supabase est très limité en volume).
- *Database → Replication* : vérifier que `orders` figure dans la publication `supabase_realtime` (fait par la migration 001).

**Premier administrateur** : impossible depuis l'interface (droits colonne). Dans le SQL Editor (rôle `postgres`) :
`update public.profiles set platform_role = 'platform_admin' where id = '<uuid de auth.users>';`

## 2. Coordonnées de paiement
Renseignez `paymentInfo` dans `public/config.js` (T-Money, Flooz, banque…). Tant que vide, l'écran d'abonnement invite à contacter l'administration.

## 3. Vercel
*Framework Preset* « Vite » (déjà déclaré dans `vercel.json`) : `npm run build`, répertoire de sortie `dist`. `vercel.json` active `cleanUrls` et les en-têtes de sécurité (CSP `script-src 'self'`).
`.vercelignore` exclut `supabase/`, `tests/`, `docs/` et les `.md`. **Déployer le dépôt complet** (HTML racine, `js/`, `css/`, `public/`, `vite.config.js`, `package.json` + lockfile) : l'audit du 22/11 a trouvé un déploiement ne contenant que 18 fichiers `src/js/`.
Après déploiement : `npm run verify` en local, puis dérouler `docs/TESTING.md`.

## 4. Retour arrière
- Frontend : *Instant Rollback* Vercel vers le déploiement précédent. L'ancien frontend reste compatible avec la base actuelle.
- Base : les migrations sont additives. Pour désactiver les quotas : `drop trigger enforce_product_rules on public.products; drop trigger enforce_category_rules on public.categories;`.

## 5. Mise à jour des dépendances
Versions exactes dans `package.json` (supabase-js 2.109.0, chart.js 4.5.0, qrcode 1.5.4, vite 8.3.7). Choisir une version publiée depuis plus de 14 jours, puis `npm run verify`.
