import type { ChatAnswerRequest, ChatPlanRequest, InferTypesRequest } from '../shared/contracts.js';

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
- description : une phrase courte en français décrivant la colonne, ou null.

Les valeurs masquées apparaissent sous la forme «[courriel]», «[téléphone]», etc. Réponds pour toutes les colonnes reçues, avec le même id.`;

export function inferTypesUser(req: InferTypesRequest): string {
  return `Jeu de données : ${req.datasetName}\n\nColonnes :\n${JSON.stringify(req.columns, null, 2)}`;
}

export function chatPlanSystem(req: ChatPlanRequest): string {
  return `Tu es un analyste de données. Tu réponds aux questions sur un jeu de données en écrivant UNE requête SQL DuckDB
qui sera exécutée dans le navigateur de l'utilisateur. Tu ne vois jamais les lignes, seulement le schéma et des statistiques.

Table : "${req.table}" (${req.rowCount} lignes)
${scope(req.activeFilters)}
Colonnes (utilise toujours l'id entre guillemets doubles dans le SQL, et le nom pour t'exprimer) :
${JSON.stringify(req.columns, null, 2)}

Règles :
- Une seule instruction SELECT (WITH autorisé). Aucune autre instruction (pas de CREATE, INSERT, COPY, ATTACH, PRAGMA, INSTALL, LOAD…).
- Les colonnes de type date sont de type DATE (AAAA-MM-JJ). Utilise date_trunc('month', "cX") pour regrouper par période.
- Les valeurs nulles comptent : COUNT(*) inclut les lignes nulles, et un regroupement doit conserver le groupe NULL.
- Ne fais jamais la somme ou la moyenne d'une colonne de rôle identifier.
- Limite les regroupements catégoriels aux 10 groupes les plus importants (ORDER BY … DESC LIMIT 10), sans catégorie « Autres ».
- Donne des alias lisibles en français aux colonnes du résultat (ex. AS "Montant total").
- N'ajoute pas de condition pour les filtres déjà appliqués à la table.
- Si la question est ambiguë ou impossible avec ces colonnes, réponds kind=clarify avec une question précise.
- message : une phrase en français expliquant ce que calcule la requête.
- literals : liste chaque valeur texte que le SQL compare à une colonne par = ou IN (ex. "c1" = 'Montréal'),
  avec l'id de la colonne et la valeur telle qu'écrite. Compare les colonnes texte directement (pas de lower()).
  L'application vérifie ensuite que ces valeurs existent dans les données.
- Dans message (y compris pour kind=clarify), vouvoie l'utilisateur, utilise le français québécois et désigne
  les colonnes par leur nom : ne mentionne jamais le nom technique de la table ni les id de colonnes (cX).${corrections(req)}`;
}

function scope(filters: string[]): string {
  if (!filters.length) return 'La table contient le jeu de données complet, sans filtre.';
  const lines = filters.map((f) => `- ${f}`).join('\n');
  return `La table est déjà restreinte par les filtres du dashboard (le nombre de lignes ci-dessus en tient compte ;
les statistiques des colonnes portent sur le jeu complet) :\n${lines}`;
}

function corrections(req: ChatPlanRequest): string {
  if (!req.valueCorrections?.length) return '';
  const lines = req.valueCorrections.map((v) => `- colonne ${v.columnId} : « ${v.requested} » → « ${v.actual} »`);
  return `\n\nCorrections de valeurs : les valeurs suivantes n'existent pas dans les données. Utilise exactement la valeur réelle indiquée.\n${lines.join('\n')}`;
}

export function chatAnswerSystem(): string {
  return `Tu rédiges la réponse finale à une question d'analyse de données, en français québécois, ton professionnel et concis.
Tu reçois la question, la requête SQL exécutée et son résultat. Base-toi uniquement sur ce résultat ; n'invente aucun chiffre.
Formate les nombres à la québécoise (espace comme séparateur de milliers, virgule décimale, « $ » après le montant).
Si le résultat est tronqué ou vide, dis-le. Deux à cinq phrases au plus.
Vouvoie l'utilisateur et ne mentionne jamais le nom technique de la table ni les id de colonnes (cX).
Si des filtres du dashboard sont actifs, précise brièvement que la réponse en tient compte.`;
}

export function chatAnswerUser(req: ChatAnswerRequest): string {
  const filters = req.activeFilters.length
    ? `Filtres du dashboard appliqués : ${req.activeFilters.join(' ; ')}\n\n`
    : 'Aucun filtre : jeu de données complet.\n\n';
  return `${filters}Question : ${req.question}\n\nSQL :\n${req.sql}\n\nRésultat${req.truncated ? ' (tronqué)' : ''} :\n${JSON.stringify(req.result)}`;
}
