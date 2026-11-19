/**
 * Contrats échangés entre le frontend et le proxy LLM.
 * Les schémas Zod servent à la fois à la validation côté serveur et aux
 * sorties structurées du LLM.
 *
 * Deux IA, deux niveaux de confiance :
 * - IA infonuagique (Claude) : génération du SQL seulement. Elle ne reçoit que le
 *   schéma (noms, types, rôles et descriptions des colonnes), la question et
 *   l'historique de la discussion : jamais de valeur issue des données.
 * - IA locale (Ollama, sur un serveur interne) : analyse des colonnes à l'import
 *   (échantillons masqués) et rédaction des réponses à partir des résultats.
 *   Ces routes ne sont jamais dirigées vers l'IA infonuagique.
 */
import { z } from 'zod';

const columnType = z.enum(['string', 'number', 'integer', 'boolean', 'date']);
const columnRole = z.enum(['dimension', 'measure', 'temporal', 'identifier', 'text']);

/** Capacités du serveur, pour que l'interface n'offre que ce qui est configuré. */
export const Capabilities = z.object({
  /** Modèle de l'IA locale, ou null si aucune n'est configurée. */
  localModel: z.string().nullable(),
});
export type Capabilities = z.infer<typeof Capabilities>;

// ---------------------------------------------------------------------------
// IA locale : inférence des types à l'import
// ---------------------------------------------------------------------------

export const InferTypesRequest = z.object({
  datasetName: z.string().max(300),
  columns: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        heuristicType: columnType,
        distinctCount: z.number(),
        nullRatio: z.number(),
        /** Échantillon déjà masqué côté navigateur (courriels, téléphones, etc.). */
        samples: z.array(z.string()).max(15),
      }),
    )
    .max(300),
});
export type InferTypesRequest = z.infer<typeof InferTypesRequest>;

export const InferTypesResponse = z.object({
  columns: z.array(
    z.object({
      id: z.string(),
      type: columnType,
      role: columnRole,
      datePattern: z
        .string()
        .nullable()
        .describe('Format source si type=date, avec les jetons YYYY, YY, MM, M, DD, D (ex. DD/MM/YYYY). null sinon.'),
      sensitive: z.boolean().describe('Vrai si la colonne contient probablement des renseignements personnels.'),
      description: z.string().nullable(),
    }),
  ),
});
export type InferTypesResponse = z.infer<typeof InferTypesResponse>;

// ---------------------------------------------------------------------------
// IA locale : rédaction de la réponse du chatbot à partir du résultat
// ---------------------------------------------------------------------------

export const ChatAnswerRequest = z.object({
  question: z.string().max(2000),
  sql: z.string().max(20000),
  /** Résultat agrégé, tronqué à 50 lignes côté navigateur. */
  result: z.array(z.record(z.string(), z.unknown())).max(50),
  truncated: z.boolean(),
  /** Filtres du dashboard déjà appliqués (descriptions lisibles, avec valeurs). Vide : jeu complet. */
  activeFilters: z.array(z.string().max(500)).max(50).default([]),
  /** Valeurs demandées corrigées localement (ex. « montreal » → « Montréal »), à mentionner dans la réponse. */
  notes: z.array(z.string().max(500)).max(20).default([]),
});
export type ChatAnswerRequest = z.infer<typeof ChatAnswerRequest>;

export const ChatAnswerResponse = z.object({ answer: z.string() });
export type ChatAnswerResponse = z.infer<typeof ChatAnswerResponse>;

// ---------------------------------------------------------------------------
// IA infonuagique : génération du SQL à partir du schéma seulement
// ---------------------------------------------------------------------------

/** Description d'une colonne envoyée au LLM : structure seulement, aucune valeur ni statistique. */
export const ChatColumnContext = z
  .object({
    id: z.string().max(20),
    name: z.string().max(300),
    type: columnType,
    role: columnRole,
    description: z.string().max(500).nullable().optional(),
  })
  .strict();

export const ChatTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(20000),
});

export const ChatPlanRequest = z
  .object({
    question: z.string().min(1).max(2000),
    table: z.string().max(100),
    columns: z.array(ChatColumnContext).max(1000),
    history: z.array(ChatTurn).max(20).default([]),
    /** Filtres du dashboard déjà appliqués à la table : colonne et opérateur, sans les valeurs. Vide : jeu complet. */
    activeFilters: z.array(z.string().max(500)).max(50).default([]),
    /**
     * Échec de la tentative précédente, pour permettre au LLM de corriger sa requête. Le message d'erreur est
     * expurgé dans le navigateur (les valeurs citées par DuckDB sont retirées).
     */
    previousError: z.object({ sql: z.string().max(20000), error: z.string().max(2000) }).nullable().default(null),
  })
  .strict();
export type ChatPlanRequest = z.infer<typeof ChatPlanRequest>;

export const ChatPlanResponse = z.object({
  kind: z
    .enum(['sql', 'clarify', 'unanswerable'])
    .describe(
      'sql : requête produite. clarify : la question est ambiguë, une précision de l’utilisateur suffirait. ' +
        'unanswerable : impossible de répondre avec ces colonnes, même avec une précision.',
    ),
  sql: z.string().nullable().describe('Une seule requête SELECT DuckDB, si kind=sql. null sinon.'),
  chart: z
    .enum(['table', 'pie', 'bar', 'timeline', 'kpi'])
    .describe('Représentation suggérée pour le résultat.'),
  message: z
    .string()
    .describe(
      'kind=sql : phrase présentant le résultat affiché, sans aucun chiffre. kind=clarify : la question de précision. ' +
        'kind=unanswerable : pourquoi il est impossible de répondre (quelle information manque dans les colonnes).',
    ),
  alternative: z
    .string()
    .nullable()
    .describe(
      'kind=unanswerable seulement : une question voisine, formulée comme l’utilisateur la poserait, à laquelle ' +
        'les colonnes permettent de répondre. null s’il n’y en a pas, et pour les autres kind.',
    ),
  literals: z
    .array(
      z.object({
        columnId: z.string().describe('Id de la colonne texte comparée (ex. c1).'),
        value: z.string().describe('Valeur littérale exactement telle qu’écrite dans le SQL, sans les apostrophes.'),
      }),
    )
    .describe('Valeurs texte comparées à une colonne par = ou IN dans le SQL (pas les motifs LIKE). Vide si aucune.'),
});
export type ChatPlanResponse = z.infer<typeof ChatPlanResponse>;
