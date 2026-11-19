/**
 * Modèle de données central.
 *
 * Principe : tout est une spécification déclarative. Un widget ne contient
 * jamais de données, seulement la description de la requête (QuerySpec) et
 * de sa représentation. On peut ainsi le sauvegarder, le partager ou le faire
 * générer par le chatbot.
 */

// ---------------------------------------------------------------------------
// Schéma des jeux de données
// ---------------------------------------------------------------------------

export type ColumnType = 'string' | 'number' | 'integer' | 'boolean' | 'date';

/**
 * Rôle analytique d'une colonne, distinct de son type technique.
 * Ex. : un numéro d'employé est un `integer` mais un `identifier` : on ne le somme jamais.
 */
export type ColumnRole = 'dimension' | 'measure' | 'temporal' | 'identifier' | 'text';

export type SchemaSource = 'heuristic' | 'ai' | 'user';

export interface ColumnStats {
  count: number;
  nullCount: number;
  distinctCount: number;
  min?: string | number;
  max?: string | number;
  /** Valeurs les plus fréquentes (dimensions seulement). */
  topValues: { value: string; count: number }[];
}

export interface ColumnSchema {
  /** Identifiant stable et sûr pour SQL (c0, c1…). Les widgets s'y réfèrent. */
  id: string;
  /** Libellé d'origine dans le fichier. */
  name: string;
  type: ColumnType;
  role: ColumnRole;
  /**
   * Format source des dates (ex. « DD/MM/YYYY »), détecté par heuristique ou IA.
   * Les valeurs sont normalisées en AAAA-MM-JJ au chargement.
   */
  datePattern?: string | null;
  description?: string | null;
  /** Renseignement personnel probable : valeurs jamais envoyées au LLM. */
  sensitive: boolean;
  source: SchemaSource;
  stats?: ColumnStats;
}

export interface DatasetMeta {
  id: string;
  name: string;
  fileName: string;
  sheetName?: string;
  rowCount: number;
  columns: ColumnSchema[];
  createdAt: string;
  /** Date du dernier remplacement des données par un nouveau fichier. */
  updatedAt?: string;
}

/** Valeur brute d'une cellule après normalisation. */
export type CellValue = string | number | boolean | null;

// ---------------------------------------------------------------------------
// Requêtes
// ---------------------------------------------------------------------------

export type FilterOp =
  | 'eq' | 'neq' | 'in' | 'notIn'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'between'
  | 'contains'
  | 'isNull' | 'notNull';

export interface Filter {
  columnId: string;
  op: FilterOp;
  /** Pour eq, neq, gt, gte, lt, lte, contains. */
  value?: string | number | boolean | null;
  /** Pour in, notIn, between ([min, max]). */
  values?: (string | number | boolean | null)[];
}

/**
 * Fonctions d'agrégation. Les nulls sont pris en compte explicitement :
 * - `count`        : toutes les lignes, nulls compris (COUNT(*))
 * - `countValues`  : valeurs non nulles de la colonne
 * - `countNull`    : valeurs nulles de la colonne
 * - `countDistinct`: valeurs distinctes non nulles
 * - `sum/avg/min/max` : ignorent les nulls (comportement SQL standard)
 */
export type AggFn = 'count' | 'countValues' | 'countNull' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';

export interface Measure {
  id: string;
  fn: AggFn;
  /** Facultatif pour `count`. */
  columnId?: string;
  label?: string;
}

export type TimeGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface GroupBy {
  columnId: string;
  /** Pour les colonnes de type date. */
  timeGrain?: TimeGrain;
}

export interface SortSpec {
  /** Id d'une mesure ou d'une colonne de regroupement. */
  by: string;
  dir: 'asc' | 'desc';
}

export interface QuerySpec {
  datasetId: string;
  filters: Filter[];
  /** Vide = mode « lignes brutes » (tableau). */
  groupBy: GroupBy[];
  measures: Measure[];
  /** Colonnes affichées en mode lignes brutes. */
  columns?: string[];
  sort?: SortSpec[];
  /**
   * Nombre maximal de groupes pour la dimension catégorielle (pas de catégorie
   * « Autres » : les groupes au-delà sont simplement exclus).
   */
  groupLimit?: number;
  /** Limite de lignes en mode brut. */
  rowLimit?: number;
}

export interface QueryResult {
  columns: { key: string; label: string }[];
  rows: Record<string, CellValue>[];
  /** Vrai si des groupes ont été exclus par groupLimit. */
  truncated: boolean;
  sql: string;
}

// ---------------------------------------------------------------------------
// Widgets et dashboards
// ---------------------------------------------------------------------------

/**
 * - table    : lignes brutes ou agrégées
 * - pie      : 1 regroupement, 1 mesure
 * - bar      : 1 regroupement (+ 1 série facultative), 1..n mesures
 * - timeline : 1 regroupement temporel (+ 1 série facultative), 1..n mesures
 * - kpi      : aucune dimension, 1 mesure
 */
export type WidgetKind = 'table' | 'pie' | 'bar' | 'timeline' | 'kpi';

export interface WidgetSpec {
  id: string;
  title: string;
  kind: WidgetKind;
  query: QuerySpec;
  /**
   * Requête SQL produite par le chatbot (validée en lecture seule). Si présente,
   * elle remplace `query` (sauf `datasetId`) et les filtres globaux ne s'y appliquent pas.
   */
  sql?: string | null;
  /** Largeur dans la grille (1 à 4 colonnes). */
  span?: 1 | 2 | 3 | 4;
  /** Indicateur : texte affiché sous la valeur. Absent ou vide : libellé de la mesure (ex. « Somme – Montant »). */
  subtitle?: string | null;
  /** Indicateur : unité affichée après la valeur, précédée d'une espace insécable (ex. « $ », « % », « kg »). */
  suffix?: string | null;
}

export interface DashboardSpec {
  id: string;
  name: string;
  datasetId: string;
  widgets: WidgetSpec[];
  /** Appliqués à tous les widgets en plus de leurs propres filtres. */
  globalFilters: Filter[];
  createdAt: string;
  updatedAt: string;
}
