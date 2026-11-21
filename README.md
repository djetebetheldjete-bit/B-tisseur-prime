# Bâtisseur Archives

Archive des projets de Bâtisseur, réservée au formateur : pour chaque projet, le **lien en ligne** et le **ZIP de la version finale** (un nouveau ZIP remplace l'ancien). Aucune dépendance.

## Déploiement sur Render (même méthode que Bâtisseur)

1. Crée un dépôt GitHub `batisseur-archives` et envoie-y le contenu de ce dossier (GitHub Desktop : Commit, puis Push).
2. Sur Render : **New > Web Service**, choisis ce dépôt. Render lit `render.yaml` (plan gratuit, `node server.js`).
3. Dans **Environment**, renseigne 4 variables :
   - `ADMIN_EMAIL` : ton e-mail de formateur
   - `ADMIN_PASSWORD` : un mot de passe long, connu de toi seul
   - `SUPABASE_URL` : `https://djjtqjsfsqwatujwnuel.supabase.co`
   - `SUPABASE_KEY` : la clé **service_role** du projet Bâtisseur (Supabase > Project Settings > API Keys). Elle est secrète : uniquement dans Render, jamais dans GitHub.
4. Déploie, ouvre l'adresse Render, connecte-toi.

## Ce qui a été ajouté dans le Supabase de Bâtisseur

Uniquement du nouveau, rien d'existant n'est modifié :
- la table `arch_projects` (RLS activée, aucune politique : seul le serveur y accède)
- le bucket **privé** `batisseur-archives` (50 Mo max par fichier)

L'application lit en plus la table `cohorts` (lecture seule) pour proposer les sessions de Bâtisseur dans la liste.

## Essayer en local

```
ADMIN_EMAIL=moi@exemple.com ADMIN_PASSWORD=essai-1234 node server.js
```
Sans `SUPABASE_URL`/`SUPABASE_KEY`, les données vont dans `data/` (mode local). Tests : `npm test` et `node test/test-supabase.js`.

## Limites à connaître

- ZIP : 50 Mo maximum chacun (limite du plan gratuit Supabase).
- Plan gratuit Render : le site s'endort après inactivité et met ~30 s à se réveiller. Les données, elles, ne sont jamais perdues (elles sont dans Supabase).
