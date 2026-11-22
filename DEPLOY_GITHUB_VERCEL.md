# Publier SipokMenu sur GitHub puis Vercel

## 1. Préparer et pousser le code (Windows PowerShell)

1. Télécharge `SipokMenu_source_clean.zip` et décompresse-le dans un dossier (par exemple `Téléchargements\SipokMenu`).
2. Ouvre PowerShell **dans le dossier décompressé qui contient `index.html`**.
3. Exécute le bloc ci-dessous. Il capture d'abord le chemin source, clone le dépôt dans un autre dossier, copie le projet, puis pousse la branche `main`.

```powershell
$source = (Get-Location).Path
$dest = "$HOME\Desktop\sipokteck-menu"

# Clone le dépôt cible (si ce dossier existe déjà, vérifie-le manuellement avant de poursuivre)
git clone https://github.com/sipok12/sipokteck-menu.git $dest

# Copier tous les fichiers du projet, sans toucher au dossier .git du clone
Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $dest -Recurse -Force

Set-Location $dest
git add .
git commit -m "Publish SipokMenu v2 audited source"
git branch -M main
git push -u origin main
```

Si le clone échoue parce que le dossier existe déjà, ne le supprime pas automatiquement : vérifie son contenu et adapte le chemin de destination. Si GitHub demande une authentification, connecte-toi avec Git Credential Manager.

## 2. Vercel

Dans Vercel, projet `sipokmenu` → Settings → Git, relier `sipok12/sipokteck-menu` et choisir `main` comme production branch. Vérifier que Root Directory est `.` et Framework Preset `Other`. Puis lancer un déploiement **Preview** d'abord.

## 3. Tests avant production

- Tests unitaires : `npm test`
- Contrôle statique : `npm run check`
- Test navigateur : inscription/login, création restaurant, catégories/produits/photos, menu public, panier, commande, WhatsApp, QR, admin, facturation.
- Tester deux comptes/restaurant séparés pour confirmer l'isolation RLS.

Ne publie jamais une clé Supabase `service_role` dans `config.js`.
