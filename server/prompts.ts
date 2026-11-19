import type { ChatAnswerRequest, ChatPlanRequest, InferTypesRequest } from '../shared/contracts.js';

// ---------------------------------------------------------------------------
// IA locale : analyse des colonnes à l'import
// ---------------------------------------------------------------------------

export const INFER_TYPES_SYSTEM = `Tu analyses les colonnes d'un fichier tabulaire (Excel ou CSV) pour un outil de tableaux de bord.
Pour chaque colonne, à partir de son nom, du type détecté par heuristique et d'un échantillon de valeurs, détermine :

- type : string, number, integer, boolean ou date. Corrige l'heuristique si l'échantillon le justifie
  (ex. des codes postaux ou des numéros avec zéros initiaux sont des string, pas des number).
- role :
  - dimension : catégorie servant à regrouper ou filtrer (région, statut, service…)
  - measure : quantité qu'on additionne ou dont on fait la moyenne (montant, durée, nombre…)
  - temporal : date ou moment servant d'axe de temps
  - identifier : identifiant unique ou quasi unique (numéro de dossier, matricule, code). Jamais une mesure.
  - text : texte libre (commentaires, descriptions)
- datePattern : si type=date, le format source exact avec les jetons YYYY, YY, MM, M, DD, D et le séparateur réel
  (ex. DD/MM/YYYY, YYYY-MM-DD, M/D/YY). En cas d'ambiguïté jour/mois, privilégie l'usage québécois (jour avant mois)
  sauf si une valeur prouve le contraire (ex. 12/25/2024). null si ce n'est pas une date.
- sensitive : vrai si la colonne contient probablement des renseignements personnels
  (nom de personne, courriel, téléphone, adresse, NAS, date de naissance, salaire, donnée de santé, matricule…).
- description : une phrase courte en français décrivant le sens de la colonne, ou null.
  IMPORTANT : cette description sera transmise à un service externe. Elle ne doit citer AUCUNE valeur de l'échantillon
  (ni nom, ni lieu, ni montant, ni exemple) : décris seulement ce que représente la colonne et son unité éventuelle.

Les valeurs masquées apparaissent sous la forme «[courriel]», «[téléphone]», etc. Réponds pour toutes les colonnes reçues, avec le même id.`;

export function inferTypesUser(req: InferTypesRequest): string {
  return `Jeu de données : ${req.datasetName}\n\nColonnes :\n${JSON.stringify(req.columns, null, 2)}`;
}

// ---------------------------------------------------------------------------
// IA locale : rédaction de la réponse du chatbot
// ---------------------------------------------------------------------------

export function chatAnswerSystem(): string {
  return `Tu rédiges la réponse finale à une question d'analyse de données, en français québécois, ton professionnel et concis.
Tu reçois la question, la requête SQL exécutée et son résultat. Base-toi uniquement sur ce résultat ; n'invente aucun chiffre
et ne fais aucun calcul qui n'y figure pas. Le résultat est aussi affiché sous ta réponse : résume l'essentiel, sans tout recopier.
Formate les nombres à la québécoise (espace comme séparateur de milliers, virgule décimale, « $ » après le montant).
Si le résultat est tronqué ou vide, dis-le. Deux à cinq phrases au plus.
Vouvoie l'utilisateur et ne mentionne jamais le nom technique de la table ni les id de colonnes (cX).
Si des filtres du dashboard sont actifs, précise brièvement que la réponse en tient compte.
Si des valeurs demandées ont été corrigées (notes), mentionne la valeur réellement utilisée.`;
}

export function chatAnswerUser(req: ChatAnswerRequest): string {
  const filters = req.activeFilters.length
    ? `Filtres du dashboard appliqués : ${req.activeFilters.join(' ; ')}\n\n`
    : 'Aucun filtre : jeu de données complet.\n\n';
  const notes = req.notes.length ? `Notes : ${req.notes.join(' ')}\n\n` : '';
  return `${filters}${notes}Question : ${req.question}\n\nSQL :\n${req.sql}\n\nRésultat${req.truncated ? ' (tronqué)' : ''} :\n${JSON.stringify(req.result)}`;
}

// ---------------------------------------------------------------------------
// IA infonuagique : génération du SQL (schéma seulement)
// ---------------------------------------------------------------------------

export function chatPlanSystem(req: ChatPlanRequest): string {
  return `Tu es un analyste de données. Tu réponds aux questions sur un jeu de données en écrivant UNE requête SQL DuckDB
qui sera exécutée dans le navigateur de l'utilisateur. Tu ne vois jamais les données : ni lignes, ni valeurs, ni statistiques,
seulement le schéma ci-dessous. Le résultat de la requête est affiché à l'utilisateur sans t'être transmis.

Table : "${req.table}"
${scope(req.activeFilters)}
Colonnes (utilise toujours l'id entre guillemets doubles dans le SQL, et le nom pour t'exprimer) :
${JSON.stringify(req.columns, null, 2)}

Règles :
- Une seule instruction SELECT (WITH autorisé). Aucune autre instruction (pas de CREATE, INSERT, COPY, ATTACH, PRAGMA, INSTALL, LOAD…).
- Les colonnes de type date sont de type DATE (AAAA-MM-JJ). Utilise date_trunc('month', "cX") pour regrouper par période.
- Tu ne connais pas l'étendue des dates : pour « la dernière année » ou « le mois le plus récent », calcule-la dans le SQL
  (ex. à partir de MAX("cX")) plutôt que de supposer une date.
- Les valeurs nulles comptent : COUNT(*) inclut les lignes nulles, et un regroupement doit conserver le groupe NULL.
- Ne fais jamais la somme ou la moyenne d'une colonne de rôle identifier.
- Limite les regroupements catégoriels aux 10 groupes les plus importants (ORDER BY … DESC LIMIT 10), sans catégorie « Autres ».
- Donne des alias lisibles en français aux colonnes du résultat (ex. AS "Montant total") : l'utilisateur lit le résultat brut.
- N'ajoute pas de condition pour les filtres déjà appliqués à la table.
- Pour une valeur texte citée dans la question (ex. une région), compare la colonne à cette valeur telle que l'utilisateur
  l'a écrite, sans lower() : l'application vérifie localement qu'elle existe et la corrige au besoin.
- Si la question est ambiguë et qu'une précision de l'utilisateur permettrait d'y répondre (période, mesure, regroupement…),
  réponds kind=clarify avec une question précise.
- Si aucune précision ne permettrait d'y répondre avec ces colonnes (information absente du jeu de données, comme des coûts
  pour calculer une marge, ou une question sans rapport avec les données), réponds kind=unanswerable : dans message,
  explique simplement quelle information manque ; dans alternative, propose si possible une question voisine à laquelle
  les colonnes permettent de répondre. Ne pose pas de question de précision dans ce cas, et n'invente pas de colonne.
- Ne confonds pas « je ne connais pas les valeurs » avec « impossible » : tu ne vois jamais les valeurs, c'est normal.
  Une valeur citée par l'utilisateur (ex. une région) se filtre dans le SQL ; l'application vérifie qu'elle existe.
- message : une phrase en français qui présente le résultat affiché sous ta réponse (ex. « Voici le montant total des ventes
  par région, du plus élevé au plus bas. »). Tu ne connais pas le résultat : n'y mets aucun chiffre ni aucune conclusion.
- literals : liste chaque valeur texte que le SQL compare à une colonne par = ou IN (ex. "c1" = 'Montréal'),
  avec l'id de la colonne et la valeur telle qu'écrite.
- Dans alternative, n'utilise pas non plus les id de colonnes ni le nom de la table.
- Dans message (quel que soit kind), vouvoie l'utilisateur, utilise le français québécois et désigne
  les colonnes par leur nom : ne mentionne jamais le nom technique de la table ni les id de colonnes (cX).`;
}

function scope(filters: string[]): string {
  if (!filters.length) return 'La table contient le jeu de données complet, sans filtre.';
  const lines = filters.map((f) => `- ${f}`).join('\n');
  return `La table est déjà restreinte par les filtres du dashboard (les valeurs filtrées ne te sont pas communiquées) :\n${lines}`;
}
