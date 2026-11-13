# TQ Dashboard

Outil de reporting : on téléverse un fichier Excel ou CSV, le schéma est détecté (heuristique, puis IA), on construit des widgets (tableau, tarte, colonnes, timeline, indicateur) qu'on regroupe dans des dashboards, et un chatbot répond aux questions sur les données.

## Démarrage

```bash
npm install
cp .env.example .env   # renseigner ANTHROPIC_API_KEY
npm run dev            # Vite (5176, fixe) + proxy API (8787)
npm test
```

## Architecture

```
web/src/lib/ingest.ts    Lecture xlsx (SheetJS) / csv (PapaParse, UTF-8 ou Windows-1252), ligne d'en-tête
web/src/lib/profile.ts   Typage heuristique, rôles, masquage des renseignements personnels, statistiques
web/src/lib/dates.ts     Format source (ex. DD/MM/YYYY) → regex → AAAA-MM-JJ
web/src/lib/importer.ts  Orchestration : heuristique → IA → normalisation
web/src/lib/sql.ts       QuerySpec → SQL DuckDB ; validation du SQL du chatbot
web/src/lib/db.ts        DuckDB-WASM (Web Worker) : chargement et exécution
web/src/lib/storage.ts   IndexedDB : jeux de données et dashboards
web/src/store.ts         État Zustand (métadonnées et specs seulement)
server/                  Proxy LLM (Fastify) : la clé d'API ne va jamais au navigateur
shared/                  Types et contrats Zod communs
```

Un widget est une **spécification** (`WidgetSpec` → `QuerySpec`), jamais des données. Les lignes vivent dans DuckDB et IndexedDB, pas dans React.

## Règles de calcul

- **Nulls** : ils forment un groupe « (vide) » ; « Nombre de lignes » les inclut ; « Nombre de vides » les compte ; somme, moyenne, min et max les ignorent (standard SQL). « ≠ » et « hors de » conservent les nulls.
- **Groupes** : chaque dimension catégorielle est limitée à N groupes (10 par défaut), classés selon la première mesure, sans catégorie « Autres ». L'axe temporel n'est jamais tronqué.
- **Dates** : normalisées en AAAA-MM-JJ à l'import ; ambiguïté jour/mois résolue par l'IA, sinon jour en premier.
- **Portée du chatbot** : sur un dashboard, le chat interroge la vue DuckDB `dash_<id>`, soit le jeu restreint par les filtres du dashboard (recréée quand ils changent). Le LLM reçoit la description des filtres, sans les valeurs des colonnes sensibles. Les réponses épinglées interrogent la même vue et suivent donc les filtres. Sur la page d'un jeu de données, le chat interroge la table complète, sans filtre.
- **Valeurs demandées au chatbot** : l'IA déclare les valeurs texte filtrées par son SQL (`literals`). Le navigateur vérifie qu'elles existent (`web/src/lib/valueMatch.ts`). Une valeur absente mais identique aux accents et à la casse près, ou très proche sans concurrente, est corrigée automatiquement (remplacement dans le SQL, sans appel à l'IA) et signalée. Sinon, les valeurs proches (Jaro-Winkler, Levenshtein, inclusion de mot, dans `web/src/lib/fuzzy.ts`) sont proposées en boutons lorsque le résultat est vide. Les valeurs des colonnes sensibles ne sont jamais envoyées à l'IA.
- **Discussions du chatbot** : sur un dashboard, une discussion n'est enregistrée que sur demande (bouton « Enregistrer », avec un nom proposé à partir de la première question). Une fois enregistrée, elle n'est mise à jour que sur un nouvel « Enregistrer » ; les modifications en attente sont signalées et une confirmation est demandée avant de quitter la discussion. Une discussion reprise renvoie ses derniers échanges à l'IA comme contexte, les nouvelles questions suivent les filtres actuels du dashboard, et les résultats déjà affichés restent tels qu'enregistrés. Elles sont stockées dans IndexedDB (`thread:<dashboard>:<id>`, avec les résultats affichés) et supprimées avec leur dashboard. Elles ne sont pas incluses dans l'export de dashboard. Le chat de la page d'un jeu de données n'en enregistre pas.

## Données et IA

- Les lignes ne quittent jamais le navigateur.
- Inférence des types : noms de colonnes et échantillon de 12 valeurs masquées (courriels, téléphones, codes postaux, NAS) ; aucun échantillon pour les colonnes sensibles.
- Chatbot : schéma et statistiques (pas de valeurs pour les colonnes sensibles), puis le résultat agrégé (50 lignes max) pour rédiger la réponse.
- Le SQL généré est traité comme non fiable : une seule requête SELECT, aucune fonction de lecture de fichier ni URL, exécution enveloppée et plafonnée.

## Persistance

Les jeux de données et les dashboards sont enregistrés dans IndexedDB, dans le navigateur. IndexedDB est propre à chaque origine : `http://localhost:5176` et `http://localhost:5173` sont deux bases distinctes, tout comme `localhost` et `127.0.0.1`, ou deux navigateurs ou profils différents. Le port de l'interface est donc fixe (`WEB_PORT`, 5176 par défaut) et strict : si le port est occupé, Vite s'arrête au lieu d'en prendre un autre. Une fenêtre de navigation privée efface ses données à la fermeture.

## Export et import de dashboards

Le bouton **Exporter** d'un dashboard télécharge un fichier `.tqdash.json` : nom, filtres, widgets et leurs paramètres (y compris le SQL des réponses épinglées), ainsi que le nom et le type des colonnes utilisées. Il ne contient aucune ligne de données ni statistique, mais les valeurs saisies dans les filtres y figurent ; une confirmation est demandée si un filtre porte sur une colonne sensible.

Le bouton **Importer un dashboard**, sur la page d'un jeu de données, crée un nouveau dashboard rattaché à ce jeu (`web/src/lib/transfer.ts`). Chaque colonne utilisée est retrouvée par son nom (à la casse et aux accents près), ou par son id si c'est le même jeu ; les ids de colonnes, de table et de vue sont réécrits, y compris dans le SQL, qui est revalidé. L'import est refusé si une colonne manque ou si son type est incompatible (entier et décimal sont interchangeables).
