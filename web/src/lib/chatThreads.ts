/**
 * Discussions du chatbot (threads), rattachées à un dashboard.
 *
 * Un thread n'est enregistré que si l'utilisateur le décide ; il est stocké
 * localement (IndexedDB), comme les données, et peut être repris plus tard.
 */
import type { ChatPlanRequest, ChatPlanResponse } from '../../../shared/contracts';
import type { DatasetMeta, QueryResult } from '../../../shared/types';

/** `sql` peut contenir des valeurs corrigées localement ; `modelSql` est le SQL tel qu'écrit par le LLM. */
export type Plan = ChatPlanResponse & { sql: string; modelSql?: string };
export type History = ChatPlanRequest['history'];

/** Table interrogée : vue filtrée du dashboard, ou table complète du jeu de données. */
export interface Scope {
  table: string;
  /** Descriptions envoyées au LLM : colonnes et opérateurs, sans les valeurs. */
  activeFilters: string[];
  /** Descriptions affichées localement. */
  labels: string[];
}

/** Valeur demandée absente des données, avec les valeurs proches à proposer. */
export interface Suggestion {
  columnId: string;
  columnName: string;
  requested: string;
  options: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Phrase produite par le LLM (présentation ou clarification). Présente seulement sur ses messages. */
  explanation?: string;
  /** SQL tel qu'écrit par le LLM, sans les corrections de valeurs faites localement. */
  modelSql?: string;
  /** Message contenant des valeurs des données : affiché, mais jamais renvoyé au LLM dans l'historique. */
  local?: boolean;
  /** Réponse du LLM indiquant qu'il est impossible de répondre avec les colonnes disponibles. */
  unanswerable?: boolean;
  /** Question voisine proposée par le LLM quand il ne peut pas répondre, posable d'un clic. */
  alternative?: string;
  /** Moment où le résultat a été calculé (ou actualisé). */
  computedAt?: string;
  /** Filtres du dashboard en vigueur lors du calcul (descriptions lisibles). */
  computedFilters?: string[];
  sql?: string;
  chart?: ChatPlanResponse['chart'];
  result?: QueryResult;
  question?: string;
  error?: boolean;
  notes?: string[];
  suggestions?: Suggestion[];
  /** Contexte pour relancer le calcul quand l'utilisateur choisit une suggestion. */
  pending?: { question: string; history: History; plan: Plan; scope: Scope };
}

export interface ChatThread {
  id: string;
  dashboardId: string;
  name: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Ce qui est envoyé au LLM
// ---------------------------------------------------------------------------

/** Contexte envoyé au LLM : le schéma seulement (aucune ligne, aucune valeur, aucune statistique). */
export function schemaContext(meta: DatasetMeta): ChatPlanRequest['columns'] {
  return meta.columns.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    role: c.role,
    description: c.description?.trim() || null,
  }));
}

/**
 * Historique envoyé au LLM : les questions de l'utilisateur, et pour l'assistant seulement ce que le LLM a lui-même
 * produit (sa phrase de présentation et son SQL). Les résultats, les notes et les messages contenant des valeurs
 * des données (choix d'une valeur proposée, erreurs) restent dans le navigateur.
 */
export function historyFor(messages: ChatMessage[]): History {
  const turns: History = [];
  for (const m of messages) {
    if (m.local) continue;
    if (m.role === 'user') turns.push({ role: 'user', content: m.text });
    // Seuls les messages produits par le LLM portent `explanation`. Les anciens messages (réponses rédigées à partir
    // des résultats, avant ce fonctionnement) n'en ont pas et ne sont donc jamais renvoyés.
    else if (m.explanation !== undefined) {
      const parts = [m.explanation, m.modelSql && `(SQL : ${m.modelSql})`].filter(Boolean);
      turns.push({ role: 'assistant', content: parts.join('\n') });
    }
  }
  return turns.slice(-10);
}

/** Retire d'un message d'erreur DuckDB les valeurs citées entre apostrophes (elles peuvent venir des données). */
export function redactDbError(message: string): string {
  return message.replace(/'(?:[^']|'')*'/g, "'…'").slice(0, 2000);
}

// ---------------------------------------------------------------------------
// Actualisation des résultats d'une discussion
// ---------------------------------------------------------------------------

/** Réponse dont le résultat peut être recalculé en réexécutant son SQL (déjà validé et corrigé localement). */
export function isRefreshable(m: ChatMessage): boolean {
  return m.role === 'assistant' && !!m.sql && !!m.result && !m.error;
}

/**
 * Résultat périmé : calculé avant la dernière mise à jour des données, ou avec d'autres filtres de dashboard.
 * Pour un message plus ancien que ce suivi (sans `computedAt`), la date d'enregistrement de la discussion sert de repère.
 */
export function isStale(
  m: ChatMessage,
  ctx: { dataUpdatedAt?: string; filters: string[]; savedAt?: string },
): boolean {
  if (!isRefreshable(m)) return false;
  const at = m.computedAt ?? ctx.savedAt;
  if (ctx.dataUpdatedAt && (!at || at < ctx.dataUpdatedAt)) return true;
  return !!m.computedFilters && JSON.stringify(m.computedFilters) !== JSON.stringify(ctx.filters);
}

// ---------------------------------------------------------------------------
// Discussions enregistrées
// ---------------------------------------------------------------------------

export const THREAD_NAME_MAX = 80;

/** Nom proposé par défaut : la première question, abrégée. */
export function defaultThreadName(messages: ChatMessage[], now = new Date()): string {
  const first = messages.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').trim();
  if (!first) return `Discussion du ${now.toLocaleDateString('fr-CA')}`;
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}

/** Nom saisi : espaces réduits, longueur bornée ; null s'il est vide. */
export function cleanThreadName(name: string): string | null {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, THREAD_NAME_MAX);
  return clean || null;
}

/** Plus récents d'abord. */
export function sortThreads(threads: ChatThread[]): ChatThread[] {
  return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
