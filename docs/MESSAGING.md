# Historique des commandes & messagerie restaurant–client

## Existant réutilisé (non recréé)
`orders`, `order_items`, `order_events` (alimentée par le trigger `log_order_changes` : `event_type`, `details {from,to}` — équivalent de old_status/new_status), `restaurant_stats` (évolution 7/30 j, soumise au plan), Realtime sur `orders`, rôles `owner/admin/staff`.

## Nouveautés base (migration `20261124_007_order_messaging.sql`)
- `public.messages` (RLS : lecture réservée aux membres du restaurant ; aucune écriture directe). Index : (order_id, created_at), (restaurant_id, created_at), non lus, sender_id.
- `private.order_access_tokens` : **hash SHA-256 du jeton uniquement**, expiration 30 j, révocation, clé de canal Realtime aléatoire. Table hors API.
- `submit_public_order` : l'ancienne fonction devient `private.submit_public_order_core` ; le wrapper public renvoie en plus `tracking_token` (une seule fois).
- Restaurant : `send_restaurant_message`, `mark_order_messages_read`, `list_conversations`, `reissue_order_tracking`, `revoke_order_tracking` (owner/admin), `order_history_stats`.
- Client sans compte : `track_order`, `customer_messages`, `customer_send_message` — **uniquement par jeton** ; erreur identique pour jeton inconnu, expiré ou révoqué.
- Sécurité messages : nettoyage (caractères de contrôle, zéro-largeur), 1–1000 caractères, anti-spam (client : 8 / 5 min et 200 par commande ; restaurant : 20 / min), discussion fermée 48 h après clôture de la commande ou restaurant suspendu.
- Temps réel client : trigger `notify_message` → diffusion d'un ping (id seulement, jamais le texte) sur un topic non devinable ; le client relit ensuite via RPC. Sondage de secours toutes les 15 s.

## Interface
- Onglets : Aperçu, Commandes, **Historique**, **Messages**, Produits, Catégories, Abonnement, Paramètres (personnel : sans Abonnement/Paramètres).
- Historique : période, statut, recherche n°/nom/téléphone, pagination, détails en lecture seule, chiffres de la période calculés en base, courbe 7/30 j (plan Business+).
- Messages : conversations, non lus, accusés de lecture, messages rapides, WhatsApp prérempli (jamais envoyé automatiquement), lien de suivi régénérable.
- Client : `/suivi#<jeton>` (le jeton est dans le fragment, jamais dans les journaux serveur). Lien affiché à la confirmation de commande.

## Limites connues
- Les commandes créées avant cette migration n'ont pas de lien de suivi : « Lien de suivi client » dans les détails en génère un.
- Aucune notification hors de la page ouverte (e-mail/SMS/push) : à prévoir si nécessaire.
