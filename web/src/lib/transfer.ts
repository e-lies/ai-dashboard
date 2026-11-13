/**
 * Export et import de dashboards (fichier JSON « .tqdash.json »).
 *
 * Le fichier contient la définition du dashboard (widgets, filtres, paramètres)
 * et la liste des colonnes utilisées de son jeu de données source, mais jamais
 * les lignes. À l'import, chaque colonne utilisée est retrouvée dans le jeu
 * cible par son nom ; les identifiants (colonnes, table, vue) sont réécrits,
 * y compris dans le SQL des réponses épinglées depuis le chatbot.
 */
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { ColumnSchema, DashboardSpec, DatasetMeta, Filter, WidgetSpec } from '../../../shared/types';
import { normalizeText } from './fuzzy';
import { dashboardViewName, tableName, validateReadOnlySql } from './sql';

export const TRANSFER_FORMAT = 'tq-dashboard';
export const TRANSFER_VERSION = 1;

// ---------------------------------------------------------------------------
// Schéma du fichier (le fichier importé est traité comme non fiable)
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(100);
const scalar = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

const FilterZ = z.object({
  columnId: id,
  op: z.enum(['eq', 'neq', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'isNull', 'notNull']),
  value: scalar.optional(),
  values: z.array(scalar).max(1000).optional(),
});

const QueryZ = z.object({
  datasetId: id,
  filters: z.array(FilterZ).max(100),
  groupBy: z.array(z.object({ columnId: id, timeGrain: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional() })).max(10),
  measures: z
    .array(
      z.object({
        id,
        fn: z.enum(['count', 'countValues', 'countNull', 'countDistinct', 'sum', 'avg', 'min', 'max']),
        columnId: id.optional(),
        label: z.string().max(200).optional(),
      }),
    )
    .max(20),
  columns: z.array(id).max(500).optional(),
  sort: z.array(z.object({ by: id, dir: z.enum(['asc', 'desc']) })).max(10).optional(),
  groupLimit: z.number().int().positive().max(10000).optional(),
  rowLimit: z.number().int().positive().max(100000).optional(),
});

const WidgetZ = z.object({
  id,
  title: z.string().max(300),
  kind: z.enum(['table', 'pie', 'bar', 'timeline', 'kpi']),
  query: QueryZ,
  sql: z.string().max(20000).nullable().optional(),
  span: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
});

const FileZ = z.object({
  format: z.literal(TRANSFER_FORMAT),
  version: z.literal(TRANSFER_VERSION),
  exportedAt: z.string().max(50),
  source: z.object({
    datasetId: id,
    datasetName: z.string().max(300),
    columns: z
      .array(
        z.object({
          id,
          name: z.string().max(300),
          type: z.enum(['string', 'number', 'integer', 'boolean', 'date']),
          role: z.enum(['dimension', 'measure', 'temporal', 'identifier', 'text']),
        }),
      )
      .max(1000),
  }),
  dashboard: z.object({
    id,
    name: z.string().max(300),
    globalFilters: z.array(FilterZ).max(100),
    widgets: z.array(WidgetZ).max(200),
  }),
});

export type DashboardFile = z.infer<typeof FileZ>;

// ---------------------------------------------------------------------------
// Colonnes utilisées par un dashboard
// ---------------------------------------------------------------------------

type DashLike = Pick<DashboardSpec, 'globalFilters' | 'widgets'> | DashboardFile['dashboard'];

/** Identifiants de colonnes référencés par les filtres, widgets et SQL. */
export function usedColumnIds(d: DashLike, columnIds: string[]): Set<string> {
  const known = new Set(columnIds);
  const used = new Set<string>();
  const add = (c?: string) => c && known.has(c) && used.add(c);
  const addFilters = (fs: Filter[]) => fs.forEach((f) => add(f.columnId));
  addFilters(d.globalFilters as Filter[]);
  for (const w of d.widgets) {
    const q = w.query;
    addFilters(q.filters as Filter[]);
    q.groupBy.forEach((g) => add(g.columnId));
    q.measures.forEach((m) => add(m.columnId));
    q.columns?.forEach(add);
    q.sort?.forEach((s) => add(s.by));
    if (w.sql) rewriteSqlIdentifiers(w.sql, (name) => (add(name), undefined));
  }
  return used;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportDashboard(d: DashboardSpec, meta: DatasetMeta, now = new Date()): DashboardFile {
  const used = usedColumnIds(d, meta.columns.map((c) => c.id));
  return {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: now.toISOString(),
    source: {
      datasetId: meta.id,
      datasetName: meta.name,
      // Uniquement la structure des colonnes utilisées : ni statistiques ni valeurs.
      columns: meta.columns.filter((c) => used.has(c.id)).map(({ id, name, type, role }) => ({ id, name, type, role })),
    },
    dashboard: { id: d.id, name: d.name, globalFilters: d.globalFilters, widgets: d.widgets },
  };
}

/** Colonnes sensibles dont des valeurs figurent dans les filtres du dashboard. */
export function sensitiveFilterColumns(d: DashboardSpec, meta: DatasetMeta): ColumnSchema[] {
  const ids = new Set<string>();
  const scan = (fs: Filter[]) => fs.forEach((f) => f.op !== 'isNull' && f.op !== 'notNull' && ids.add(f.columnId));
  scan(d.globalFilters);
  d.widgets.forEach((w) => scan(w.query.filters));
  return meta.columns.filter((c) => c.sensitive && ids.has(c.id));
}

export function exportFileName(name: string): string {
  const slug = normalizeText(name).replace(/ /g, '-').slice(0, 60) || 'dashboard';
  return `${slug}.tqdash.json`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function parseDashboardFile(text: string): DashboardFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Le fichier n’est pas un JSON valide.');
  }
  if ((raw as { format?: unknown })?.format !== TRANSFER_FORMAT) {
    throw new Error('Ce fichier n’est pas un export de dashboard TQ Dashboard.');
  }
  if ((raw as { version?: unknown }).version !== TRANSFER_VERSION) {
    throw new Error('Version de fichier non prise en charge.');
  }
  const parsed = FileZ.safeParse(raw);
  if (!parsed.success) throw new Error('Le fichier de dashboard est incomplet ou corrompu.');
  return parsed.data;
}

const TYPE_FAMILY: Record<string, string> = { number: 'num', integer: 'num', string: 'str', boolean: 'bool', date: 'date' };
const TYPE_LABEL: Record<string, string> = { number: 'nombre', integer: 'entier', string: 'texte', boolean: 'booléen', date: 'date' };

export interface ImportPlan {
  /** Id de colonne source → id de colonne cible. */
  mapping: Map<string, string>;
  /** Colonnes utilisées introuvables dans le jeu cible. */
  missing: string[];
  /** Colonnes trouvées mais de type incompatible. */
  incompatible: string[];
}

/** Associe chaque colonne utilisée à une colonne du jeu cible (même jeu : par id ; sinon par nom). */
export function planImport(file: DashboardFile, target: DatasetMeta): ImportPlan {
  const mapping = new Map<string, string>();
  const missing: string[] = [];
  const incompatible: string[] = [];
  const taken = new Set<string>();
  const sameDataset = file.source.datasetId === target.id;

  for (const src of file.source.columns) {
    const byId = sameDataset ? target.columns.find((c) => c.id === src.id) : undefined;
    const free = target.columns.filter((c) => !taken.has(c.id));
    const match =
      byId ??
      free.find((c) => c.name === src.name) ??
      free.find((c) => normalizeText(c.name) === normalizeText(src.name));
    if (!match) {
      missing.push(src.name);
      continue;
    }
    if (TYPE_FAMILY[match.type] !== TYPE_FAMILY[src.type]) {
      incompatible.push(`${src.name} (${TYPE_LABEL[src.type]} attendu, ${TYPE_LABEL[match.type]} trouvé)`);
      continue;
    }
    taken.add(match.id);
    mapping.set(src.id, match.id);
  }
  return { mapping, missing, incompatible };
}

/**
 * Crée un nouveau dashboard rattaché au jeu cible. Lève une erreur si une
 * colonne utilisée manque ou n'a pas un type compatible.
 */
export function importDashboard(
  file: DashboardFile,
  target: DatasetMeta,
  opts: { now?: Date; newId?: () => string } = {},
): DashboardSpec {
  const newId = opts.newId ?? (() => nanoid(10));
  const now = (opts.now ?? new Date()).toISOString();
  const d = file.dashboard;

  // Toute colonne référencée doit être décrite dans le fichier.
  const declared = file.source.columns.map((c) => c.id);
  const undeclared = [...collectRefs(d)].filter((c) => !declared.includes(c));
  if (undeclared.length) throw new Error('Le fichier de dashboard est incohérent (colonnes non décrites).');

  const plan = planImport(file, target);
  const problems: string[] = [];
  if (plan.missing.length) problems.push(`colonnes introuvables : ${plan.missing.join(', ')}`);
  if (plan.incompatible.length) problems.push(`types incompatibles : ${plan.incompatible.join(', ')}`);
  if (problems.length) {
    throw new Error(`Ce dashboard ne correspond pas au jeu « ${target.name} » (${problems.join(' ; ')}).`);
  }

  const id = newId();
  const col = (c: string) => plan.mapping.get(c) ?? c;
  const mapFilters = (fs: Filter[]): Filter[] => fs.map((f) => ({ ...f, columnId: col(f.columnId) }));
  const idents = new Map<string, string>([
    ...plan.mapping,
    [tableName(file.source.datasetId), tableName(target.id)],
    [dashboardViewName(d.id), dashboardViewName(id)],
  ]);

  const widgets: WidgetSpec[] = d.widgets.map((w) => {
    const q = w.query;
    const sql = w.sql ? validateReadOnlySql(rewriteSqlIdentifiers(w.sql, (name) => idents.get(name))) : w.sql;
    return {
      ...w,
      id: nanoid(8),
      sql,
      query: {
        ...q,
        datasetId: target.id,
        filters: mapFilters(q.filters as Filter[]),
        groupBy: q.groupBy.map((g) => ({ ...g, columnId: col(g.columnId) })),
        measures: q.measures.map((m) => (m.columnId ? { ...m, columnId: col(m.columnId) } : m)),
        columns: q.columns?.map(col),
        sort: q.sort?.map((s) => ({ ...s, by: col(s.by) })),
      },
    };
  });

  return {
    id,
    name: d.name,
    datasetId: target.id,
    widgets,
    globalFilters: mapFilters(d.globalFilters as Filter[]),
    createdAt: now,
    updatedAt: now,
  };
}

/** Références de colonnes (hors SQL, dont les identifiants ne sont pas tous des colonnes). */
function collectRefs(d: DashboardFile['dashboard']): Set<string> {
  const refs = new Set<string>();
  d.globalFilters.forEach((f) => refs.add(f.columnId));
  for (const w of d.widgets) {
    const q = w.query;
    const measureIds = new Set(q.measures.map((m) => m.id));
    q.filters.forEach((f) => refs.add(f.columnId));
    q.groupBy.forEach((g) => refs.add(g.columnId));
    q.measures.forEach((m) => m.columnId && refs.add(m.columnId));
    q.columns?.forEach((c) => refs.add(c));
    q.sort?.forEach((s) => !measureIds.has(s.by) && refs.add(s.by));
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Réécriture des identifiants dans le SQL
// ---------------------------------------------------------------------------

/**
 * Remplace les identifiants (entre guillemets doubles ou nus) selon `map`, en
 * une seule passe : pas de remplacement en cascade (c0→c1 puis c1→c2), et les
 * chaînes, commentaires et alias non reconnus restent intacts.
 */
export function rewriteSqlIdentifiers(sql: string, map: (name: string) => string | undefined): string {
  const token = /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_]*)/g;
  return sql.replace(token, (m, quoted: string | undefined, bare: string | undefined) => {
    if (quoted !== undefined) {
      const to = map(quoted.replace(/""/g, '"'));
      return to === undefined ? m : `"${to.replace(/"/g, '""')}"`;
    }
    if (bare !== undefined) {
      const to = map(bare);
      return to === undefined ? m : `"${to.replace(/"/g, '""')}"`;
    }
    return m;
  });
}
