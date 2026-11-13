/**
 * Contrats échangés entre le frontend et le proxy LLM.
 * Les schémas Zod servent à la fois à la validation côté serveur et aux
 * sorties structurées du LLM.
 */
import { z } from 'zod';

const columnType = z.enum(['string', 'number', 'integer', 'boolean', 'date']);
const columnRole = z.enum(['dimension', 'measure', 'temporal', 'identifier', 'text']);

// ---------------------------------------------------------------------------
// Inférence des types
// ---------------------------------------------------------------------------

export const InferTypesRequest = z.object({
  datasetName: z.string(),
  columns: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      heuristicType: columnType,
      distinctCount: z.number(),
      nullRatio: z.number(),
      /** Échantillon déjà masqué côté navigateur (courriels, téléphones, etc.). */
      samples: z.array(z.string()).max(15),
    }),
  ).max(300),
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
// Chatbot
// ---------------------------------------------------------------------------

/** Description d'une colonne envoyée au LLM : jamais de lignes brutes. */
export const ChatColumnContext = z.object({
  id: z.string(),
  name: z.string(),
  type: columnType,
  role: columnRole,
  description: z.string().nullable().optional(),
  nullCount: z.number().optional(),
  distinctCount: z.number().optional(),
  min: z.union([z.string(), z.number()]).nullable().optional(),
  max: z.union([z.string(), z.number()]).nullable().optional(),
  /** Absent pour les colonnes sensibles. */
  topValues: z.array(z.string()).optional(),
});

export const ChatTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

export const ChatPlanRequest = z.object({
  question: z.string().min(1).max(2000),
  table: z.string(),
  rowCount: z.number(),
  columns: z.array(ChatColumnContext),
  history: z.array(ChatTurn).max(20).default([]),
  /** Filtres du dashboard déjà appliqués à la table interrogée (descriptions lisibles). Vide : jeu complet. */
  activeFilters: z.array(z.string().max(500)).max(50).default([]),
  /** Erreur de la tentative précédente, pour permettre au LLM de corriger sa requête. */
  previousError: z.object({ sql: z.string(), error: z.string() }).nullable().default(null),
  /** Valeurs demandées absentes des données, remplacées par la valeur existante la plus proche. */
  valueCorrections: z
    .array(z.object({ columnId: z.string(), requested: z.string(), actual: z.string() }))
    .max(20)
    .nullable()
    .default(null),
});
export type ChatPlanRequest = z.infer<typeof ChatPlanRequest>;

export const ChatPlanResponse = z.object({
  kind: z.enum(['sql', 'clarify']),
  sql: z.string().nullable().describe('Une seule requête SELECT DuckDB, si kind=sql.'),
  chart: z
    .enum(['table', 'pie', 'bar', 'timeline', 'kpi'])
    .describe('Représentation suggérée pour le résultat.'),
  message: z.string().describe('Question de clarification, ou courte explication de la requête.'),
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

export const ChatAnswerRequest = z.object({
  question: z.string(),
  sql: z.string(),
  /** Résultat agrégé, tronqué à 50 lignes côté navigateur. */
  result: z.array(z.record(z.string(), z.unknown())).max(50),
  truncated: z.boolean(),
  /** Filtres du dashboard déjà appliqués à la table interrogée (descriptions lisibles). Vide : jeu complet. */
  activeFilters: z.array(z.string().max(500)).max(50).default([]),
});
export type ChatAnswerRequest = z.infer<typeof ChatAnswerRequest>;

export const ChatAnswerResponse = z.object({ answer: z.string() });
export type ChatAnswerResponse = z.infer<typeof ChatAnswerResponse>;
