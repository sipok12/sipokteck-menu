# Architecture

## Modèle de données (schéma `public`)
`profiles` (rôle plateforme `user | platform_admin`) · `restaurants` (statut `pending → active ⇄ suspended`) · `restaurant_members` (rôle `owner | admin | staff`) ·
`categories` · `products` (FR/EN, prix `price_xof`) · `orders` / `order_items` / `order_events` · `plans` · `subscriptions` · `payments` · `audit_logs`.
Le schéma `private` contient les fonctions d'autorisation (`is_platform_admin`, `has_restaurant_role`, `restaurant_limits`…) et la table d'anti-spam des commandes ; il n'est pas exposé par l'API.

## Rôles
| Rôle | Peut |
|---|---|
| Anonyme | Lire les menus de restaurants **actifs** ; passer une commande via `submit_public_order` |
| `staff` | Lire le catalogue, traiter les commandes (statut, paiement) |
| `owner` / `admin` du restaurant | + gérer catalogue, paramètres, demander un abonnement, lire facturation et stats |
| `platform_admin` | Valider restaurants et paiements, modifier les offres, lire le journal d'audit |

## Garde-fous côté base (vérifiés par tests annulés sur la base réelle)
- `profiles` : seuls `full_name`, `phone`, `avatar_url` sont modifiables par l'utilisateur (droits colonne) → pas d'auto-promotion admin.
- `restaurants` : `status`, `created_by`, `slug` verrouillés pour le restaurateur ; 3 restaurants maximum par compte ; WhatsApp normalisé (8–15 chiffres) ; URLs https.
- `orders` : seul `status` / `payment_status` modifiable depuis le client ; une commande terminée/annulée ne se rouvre pas ; historique dans `order_events`.
- `products` / `categories` : cohérence multi-restaurant, quotas de l'offre (verrou consultatif contre les courses), prix ≤ 10 000 000.
- `submit_public_order` : prix lus en base, quantités et UUID validés, pas de doublons de lignes, 5 commandes / 10 min / téléphone / restaurant.
- Paiements : `request_subscription` lit le montant dans `plans` ; `admin_review_payment` est le seul chemin de validation ; le renouvellement s'ajoute à la période en cours.
- `restaurant_stats` : verrouillé côté serveur aux offres dont `features.basic_stats` est vrai.
- Storage : chemin imposé `<restaurant_id>/<fichier>` ; `payment-proofs` privé.
- `audit_logs` : alimenté uniquement par des triggers `SECURITY DEFINER` (restaurants, paiements, abonnements, offres).

## Frontend
Chaque page a un point d'entrée dans `js/pages/`. Les accès Supabase sont **uniquement** dans `js/services/` ; les modules d'onglets du tableau de bord reçoivent un
contexte (`ctx`) et ne parlent jamais directement à la base. Toute chaîne affichée passe par `t()` ; toute donnée insérée dans le HTML passe par `esc()` ; les URL d'images par `safeUrl()` (https).
Les erreurs techniques sont traduites par `friendlyError()` : aucun message SQL brut n'est montré à l'utilisateur.
La console admin est volontairement en français uniquement.

## Flux principaux
1. **Inscription** → `profiles` créé par trigger → onboarding → restaurant `pending` + membre `owner` (trigger).
2. **Validation** admin (`restaurants.status = active`) → menu public et QR actifs.
3. **Commande** : menu → `submit_public_order` → apparition en direct (Realtime + relève toutes les 30 s) → statuts → historique.
4. **Abonnement** : choix d'offre → `request_subscription` (+ justificatif privé) → `admin_review_payment` → quotas de l'offre appliqués.

## Build (v2.1)
Vite multi-pages : chaque `*.html` racine est un point d'entrée ; `public/config.js` est servi tel quel (chargé avant les modules). Chart.js est chargé à la demande (`import('chart.js/auto')`, chunk séparé).
Les tests unitaires injectent un faux client Supabase via `globalThis.__SIPOKMENU_CLIENT_FACTORY__` (voir `js/core/supabase.js`).
