# TQ Dashboard

Outil de reporting : on téléverse un fichier Excel ou CSV, le schéma est détecté (heuristique, puis IA locale facultative), on construit des widgets (tableau, tarte, colonnes, timeline, indicateur) qu'on regroupe dans des dashboards, et un chatbot répond aux questions sur les données.

## Démarrage

```bash
npm install
cp .env.example .env   # renseigner ANTHROPIC_API_KEY, et LOCAL_LLM_URL / LOCAL_LLM_MODEL pour l'IA locale
npm run dev            # Vite (5176, fixe) + proxy API (8787)
npm test
```

## Architecture

```
web/src/lib/ingest.ts    Lecture xlsx (SheetJS) / csv (PapaParse, UTF-8 ou Windows-1252), ligne d'en-tête
web/src/lib/profile.ts   Typage heuristique, rôles, masquage des renseignements personnels, statistiques
web/src/lib/dates.ts     Format source (ex. DD/MM/YYYY) → regex → AAAA-MM-JJ
web/src/lib/importer.ts  Orchestration : heuristique → IA locale (facultative) → normalisation
web/src/lib/sql.ts       QuerySpec → SQL DuckDB ; validation du SQL du chatbot
web/src/lib/db.ts        DuckDB-WASM (Web Worker) : chargement et exécution
web/src/lib/storage.ts   IndexedDB : jeux de données et dashboards
web/src/store.ts         État Zustand (métadonnées et specs seulement)
server/                  Proxy LLM (Fastify) : Claude pour le SQL, Ollama (server/llm/ollama.ts) pour le reste
shared/                  Types et contrats Zod communs
```

Un widget est une **spécification** (`WidgetSpec` → `QuerySpec`), jamais des données. Les lignes vivent dans DuckDB et IndexedDB, pas dans React.

## Règles de calcul

- **Nulls** : ils forment un groupe « (vide) » ; « Nombre de lignes » les inclut ; « Nombre de vides » les compte ; somme, moyenne, min et max les ignorent (standard SQL). « ≠ » et « hors de » conservent les nulls.
- **Groupes** : chaque dimension catégorielle est limitée à N groupes (10 par défaut), classés selon la première mesure, sans catégorie « Autres ». L'axe temporel n'est jamais tronqué.
- **Tableaux** : un widget tableau accepte jusqu'à 6 regroupements (un graphique : 2, axe et série ; une tarte : 1). Chaque en-tête de colonne est triable (croissant, décroissant, puis ordre par défaut), les valeurs vides restant à la fin. Pour un tableau défini dans l'éditeur, le tri est fait par DuckDB sur toutes les données ; cliquer dans l'aperçu de l'éditeur définit le tri enregistré, alors que sur le dashboard le tri ne vaut que pour l'affichage en cours. Les tableaux issus du chatbot sont triés sur leur résultat affiché.
- **Dates** : normalisées en AAAA-MM-JJ à l'import ; ambiguïté jour/mois résolue par l'IA locale si elle est configurée, sinon jour en premier et colonne signalée pour vérification.
- **Portée du chatbot** : sur un dashboard, le chat interroge la vue DuckDB `dash_<id>`, soit le jeu restreint par les filtres du dashboard (recréée quand ils changent). Le LLM apprend quelles colonnes sont filtrées et par quel opérateur, sans les valeurs. Les réponses épinglées interrogent la même vue et suivent donc les filtres. Sur la page d'un jeu de données, le chat interroge la table complète, sans filtre.
- **Valeurs demandées au chatbot** : l'IA déclare les valeurs texte filtrées par son SQL (`literals`). Le navigateur vérifie qu'elles existent (`web/src/lib/valueMatch.ts`). Une valeur absente mais identique aux accents et à la casse près, ou très proche sans concurrente, est corrigée automatiquement (remplacement dans le SQL, sans appel à l'IA) et signalée. Sinon, les valeurs proches (Jaro-Winkler, Levenshtein, inclusion de mot, dans `web/src/lib/fuzzy.ts`) sont proposées en boutons lorsque le résultat est vide. Les valeurs réelles ne sont jamais envoyées à l'IA infonuagique : si le littéral ne peut pas être remplacé dans le SQL, l'utilisateur est invité à reformuler avec la valeur existante.
- **Réponses de Claude sans SQL** : si la question est ambiguë mais qu'une précision suffirait, Claude pose une question de précision ; la réponse de l'utilisateur repart avec cet échange dans l'historique. Si aucune précision ne permettrait de répondre avec les colonnes disponibles (information absente, question sans rapport), Claude l'indique (`kind=unanswerable`) en expliquant ce qui manque, et propose si possible une question voisine, posable d'un clic. Dans les deux cas, aucune requête n'est exécutée et l'IA locale n'est pas appelée.
- **Discussions du chatbot** : sur un dashboard, une discussion n'est enregistrée que sur demande (bouton « Enregistrer », avec un nom proposé à partir de la première question). Une fois enregistrée, elle n'est mise à jour que sur un nouvel « Enregistrer » ; les modifications en attente sont signalées et une confirmation est demandée avant de quitter la discussion. Une discussion reprise renvoie ses derniers échanges à l'IA infonuagique comme contexte (questions, phrases et SQL qu'elle a produits, sans les résultats ni les réponses rédigées localement), les nouvelles questions suivent les filtres actuels du dashboard, et les résultats déjà affichés restent tels qu'enregistrés. Elles sont stockées dans IndexedDB (`thread:<dashboard>:<id>`, avec les résultats affichés) et supprimées avec leur dashboard. Elles ne sont pas incluses dans l'export de dashboard. Le chat de la page d'un jeu de données n'en enregistre pas. Chaque résultat garde la date de son calcul et les filtres en vigueur : si les données ont été mises à jour depuis, ou si les filtres ont changé, un avertissement propose **Actualiser les résultats**. Le SQL enregistré (déjà validé et corrigé localement) est alors réexécuté sur les données et les filtres actuels, sans appel à l'IA infonuagique ; l'IA locale, si elle est configurée, rédige de nouveau la réponse. L'actualisation n'est enregistrée qu'au prochain « Enregistrer ».

## Données et IA

Deux IA, deux niveaux de confiance. Les lignes ne quittent jamais le navigateur.

| Tâche | IA | Ce qu'elle reçoit |
|---|---|---|
| Génération du SQL du chatbot (`/api/chat/plan`) | Infonuagique (Claude, `LLM_MODEL`) | La question, le schéma (id, nom, type, rôle, description), les filtres actifs sans leurs valeurs, l'historique limité aux questions et à ce qu'elle a produit |
| Analyse des colonnes à l'import (`/api/infer-types`) | Locale (Ollama, `LOCAL_LLM_MODEL`) | Noms de colonnes, et 12 valeurs par colonne, masquées (courriels, téléphones, codes postaux, NAS) ; aucune pour les colonnes sensibles |
| Rédaction de la réponse du chatbot (`/api/chat/answer`) | Locale | La question, le SQL, le résultat (50 lignes au plus), les filtres avec leurs valeurs |

- Les routes `/api/infer-types` et `/api/chat/answer` n'utilisent que l'IA locale : sans elle, elles répondent 503 et ne sont jamais redirigées vers l'IA infonuagique. L'interface ne les appelle que si `/api/capabilities` annonce une IA locale. Sans IA locale, l'import reste heuristique et le chat affiche le résultat sous la phrase de présentation du SQL ; si l'IA locale ne répond pas, même repli, avec une note.
- Le contrat de `/api/chat/plan` est strict (`shared/contracts.ts`) : le serveur refuse tout champ supplémentaire, comme des statistiques ou un résultat. Les corrections de valeurs se font dans le navigateur ; le SQL corrigé, les valeurs choisies parmi les suggestions et les réponses rédigées localement ne sont pas renvoyés à l'IA infonuagique. Les messages d'erreur de DuckDB transmis pour corriger une requête sont expurgés des valeurs citées.
- Les descriptions de colonnes, proposées par l'IA locale à l'import (consigne : ne citer aucune valeur) et modifiables dans l'éditeur de schéma, sont transmises telles quelles à l'IA infonuagique : à relire, elles ne doivent contenir aucune donnée réelle. Ce que l'utilisateur tape dans ses questions est aussi transmis tel quel.
- Le SQL généré est traité comme non fiable : une seule requête SELECT, aucune fonction de lecture de fichier ni URL, exécution enveloppée et plafonnée.
- IA locale sur un Mac : Ollama doit écouter sur le réseau (`OLLAMA_HOST=0.0.0.0`), et `LOCAL_LLM_URL` pointe vers ce Mac (ex. `http://<adresse-du-mac>:11434`). Le trafic reste sur le réseau interne mais n'est pas chiffré (HTTP).

## Persistance

Les jeux de données et les dashboards sont enregistrés dans IndexedDB, dans le navigateur. IndexedDB est propre à chaque origine : `http://localhost:5176` et `http://localhost:5173` sont deux bases distinctes, tout comme `localhost` et `127.0.0.1`, ou deux navigateurs ou profils différents. Le port de l'interface est donc fixe (`WEB_PORT`, 5176 par défaut) et strict : si le port est occupé, Vite s'arrête au lieu d'en prendre un autre. Une fenêtre de navigation privée efface ses données à la fermeture.

## Mise à jour des données

Le bouton **Mettre à jour les données**, sur la page d'un jeu de données, remplace toutes ses lignes par celles d'un nouveau fichier (Excel ou CSV), sans changer le schéma : ids, types, formats de date, rôles, descriptions et colonnes sensibles sont conservés, si bien que les dashboards, filtres et widgets restent valides et sont recalculés (`web/src/lib/refresh.ts`).

- Le fichier n'est accepté que si **toutes les colonnes du schéma** y figurent, retrouvées par leur nom (à la casse, aux accents et aux espaces près), dans n'importe quel ordre. Sinon, la mise à jour est refusée et les colonnes manquantes sont nommées. Les colonnes en trop sont ignorées.
- L'onglet d'origine est cherché en premier, puis les autres ; la ligne d'en-tête est cherchée dans les 20 premières lignes.
- Les valeurs sont converties selon le schéma actuel ; celles qui ne peuvent pas l'être deviennent vides. Une confirmation résume le nombre de lignes, les colonnes ignorées et les valeurs non convertibles avant le remplacement, qui est irréversible.
- Les statistiques des colonnes sont recalculées, et les valeurs proposées dans les filtres et vérifiées par le chatbot sont rafraîchies.

## Export et import de dashboards

Le bouton **Exporter** d'un dashboard télécharge un fichier `.tqdash.json` : nom, filtres, widgets et leurs paramètres (y compris le SQL des réponses épinglées), ainsi que le nom et le type des colonnes utilisées. Il ne contient aucune ligne de données ni statistique, mais les valeurs saisies dans les filtres y figurent ; une confirmation est demandée si un filtre porte sur une colonne sensible.

Le bouton **Importer un dashboard**, sur la page d'un jeu de données, crée un nouveau dashboard rattaché à ce jeu (`web/src/lib/transfer.ts`). Chaque colonne utilisée est retrouvée par son nom (à la casse et aux accents près), ou par son id si c'est le même jeu ; les ids de colonnes, de table et de vue sont réécrits, y compris dans le SQL, qui est revalidé. L'import est refusé si une colonne manque ou si son type est incompatible (entier et décimal sont interchangeables).
