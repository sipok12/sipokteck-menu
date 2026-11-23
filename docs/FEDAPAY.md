# Paiement en ligne des abonnements (FedaPay)

Périmètre : abonnements des restaurateurs (Starter / Business / Premium). Les commandes de plats ne sont pas concernées.
La validation manuelle par l'administrateur reste disponible (repli).

## Flux
1. Dashboard → « Payer en ligne » → Edge Function `fedapay` (action `checkout`, JWT du restaurateur).
2. La base (`start_online_payment`) vérifie le rôle owner/admin, lit le **montant dans `plans`**, crée l'abonnement `pending` et le paiement `pending` (méthode `fedapay`).
3. La fonction crée la transaction FedaPay, la rattache au paiement, génère le lien et redirige le navigateur (page hébergée FedaPay : aucune donnée de paiement ne passe par SipokMenu).
4. Confirmation, deux voies indépendantes qui relisent toujours le statut **et le montant** via l'API FedaPay avant d'agir :
   - webhook signé (`X-FEDAPAY-SIGNATURE`, HMAC-SHA256, tolérance 10 min) ;
   - retour `/dashboard?payment=<id>#billing` → action `verify`.
5. `finalize_online_payment` (service_role uniquement) est idempotente : montant différent refusé, double appel sans effet, rejet manuel de l'admin jamais écrasé. L'activation réutilise `private.activate_subscription` (la même que la validation manuelle).

## Mise en service
1. Compte FedaPay en **sandbox** : récupérer la clé secrète (`sk_sandbox_…`).
2. Secrets de la fonction (Supabase → Edge Functions → Secrets) : `FEDAPAY_SECRET_KEY`, `FEDAPAY_WEBHOOK_SECRET`, `FEDAPAY_ENV` (`sandbox` ou `live`), `SITE_URL` (`https://sipokmenu-nine.vercel.app`).
3. FedaPay → Webhooks → ajouter `https://ydhumfbcnhydgtxuzuhb.supabase.co/functions/v1/fedapay`, événements `transaction.approved`, `transaction.canceled`, `transaction.declined`; copier le secret du endpoint dans `FEDAPAY_WEBHOOK_SECRET`.
4. `public/config.js` : `onlinePayment: true`, puis déployer.
5. Test sandbox complet, puis passer en `live` (clé `sk_live_…`, nouveau endpoint webhook et nouveau secret).

## À vérifier au premier test sandbox
Le format exact de la signature (`t=…,s=…` signé sur `t.corps`) suit la convention des SDK FedaPay mais n'est pas détaillé dans leur doc publique. Si le webhook est refusé (400), le retour navigateur (`verify`) active déjà l'abonnement ; ajuster alors `validSignature` dans `supabase/functions/fedapay/index.ts`.

## Sécurité
Clés uniquement en secrets Edge Function ; colonnes `provider_*` non accessibles au client ; un restaurateur ne peut pas insérer lui-même un paiement `fedapay` ; fonctions de confirmation réservées au `service_role` ; chaque changement de statut est journalisé (`audit_logs`).
