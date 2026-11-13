/**
 * Discussions du chatbot (threads), rattachées à un dashboard.
 *
 * Un thread n'est enregistré que si l'utilisateur le décide ; il est stocké
 * localement (IndexedDB), comme les données, et peut être repris plus tard.
 */
import type { ChatPlanRequest, ChatPlanResponse } from '../../../shared/contracts';
import type { QueryResult } from '../../../shared/types';

export type Plan = ChatPlanResponse & { sql: string };
export type History = ChatPlanRequest['history'];

/** Table interrogée : vue filtrée du dashboard, ou table complète du jeu de données. */
export interface Scope {
  table: string;
  rowCount: number;
  /** Descriptions envoyées au LLM (valeurs des colonnes sensibles masquées). */
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
