# Paiement en ligne des clients (T-Money, Moov Money, carte) — FedaPay

Chaque restaurant utilise **son propre compte FedaPay** : l'argent va directement chez lui, SipokMenu ne détient aucun fonds.
Le paiement est **optionnel** : le client choisit « Payer à la réception » ou « Payer maintenant » au moment de commander.

## Mise en route (restaurateur)
1. Créer un compte FedaPay et récupérer la clé secrète (commencer par le mode test/sandbox).
2. Tableau de bord → Paramètres → « Paiement en ligne des clients » : choisir l'environnement, coller la clé, enregistrer.
   La clé est vérifiée auprès de FedaPay puis chiffrée (Supabase Vault) ; elle n'est jamais renvoyée au navigateur.
3. Dans FedaPay → Webhooks : coller l'adresse affichée (`…/functions/v1/fedapay-orders?r=<id restaurant>`),
   événements `transaction.approved`, `transaction.canceled`, `transaction.declined`. Le secret du webhook (facultatif) se saisit dans le même formulaire.

## Flux
1. Le client commande (`submit_public_order`) et reçoit un jeton de suivi.
2. S'il choisit « en ligne » : Edge Function `fedapay-orders` (action `checkout`) → `start_order_payment` relit le total en base
   (jamais envoyé par le navigateur) → transaction FedaPay → redirection vers la page de paiement hébergée.
3. Retour sur `/suivi?paid=<id>` : action `verify` ; le serveur relit l'état auprès de FedaPay. Le webhook (signature HMAC vérifiée) fait de même.
4. `finalize_order_payment` est idempotent, contrôle le montant et passe la commande à « payée » (journalisé dans l'historique).
5. Si le paiement échoue, la commande reste valide : le client peut réessayer depuis son lien de suivi.

## Sécurité
- `restaurants.online_payments` n'est modifiable que par le serveur ou l'admin plateforme (trigger `guard_online_payments`).
- Fonctions de paiement réservées à `service_role` ; clés dans Vault ; statut et montant toujours revérifiés auprès de FedaPay.
- Aucune clé dans le frontend.

## À confirmer en sandbox
Format exact de la signature webhook (`X-FEDAPAY-SIGNATURE`) et parcours complet avec un numéro de test.
