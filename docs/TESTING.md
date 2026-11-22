# Parcours de test manuel (à dérouler avant mise en production)

Les tests automatiques (`npm test`, `npm run check`) ne remplacent pas un passage dans un vrai navigateur, sur mobile et sur desktop.

1. **Inscription** (FR puis EN) : e-mail de confirmation reçu, lien vers `/dashboard`, profil créé avec le nom. Mot de passe oublié → `/reset` → nouveau mot de passe.
2. **Onboarding** : créer un restaurant (WhatsApp « +228 90 00 00 00 » accepté et normalisé) → bandeau « en attente ».
3. **Admin** : valider le restaurant dans `/admin` → le menu `/menu?slug=…` et `/qr` deviennent actifs ; l'action apparaît dans *Journal*.
4. **Catalogue** : créer catégories (FR/EN) ; produit avec photo (JPG de téléphone → réduite) ; modifier, masquer, marquer en rupture, supprimer, réordonner.
   Dépasser la limite Starter (5 catégories / 30 produits) → message de limite traduit.
5. **Menu public** (téléphone, sans compte) : recherche, catégories, panier conservé après rechargement, bascule FR/EN, livraison (adresse requise), commande.
   Option WhatsApp : le bouton ouvre WhatsApp avec le récapitulatif. Se reconnecter puis commander connecté : doit fonctionner.
6. **Commandes** : la commande apparaît en direct avec un bip ; avancer les statuts ; annuler ; historique ; une commande terminée ne se rouvre pas.
7. **Abonnement** : choisir Business → demande avec référence et capture → admin voit le justificatif (lien temporaire) → approuver →
   limites 100 produits / 15 catégories, statistiques visibles ; renouveler → la date de fin s'additionne.
8. **Sécurité** : `/admin` avec un compte non admin → refusé ; menu d'un restaurant suspendu → indisponible ; la console du navigateur ne doit afficher aucune erreur CSP.
9. **Impression** : `/qr` → Imprimer (seuls le nom, le QR et la phrase d'invitation apparaissent).
