/**
 * Compilation d'une QuerySpec en SQL DuckDB, et validation des requêtes
 * générées par le chatbot.
 */
import type { ColumnSchema, DatasetMeta, Filter, GroupBy, Measure, QuerySpec } from '../../../shared/types';

export const DEFAULT_GROUP_LIMIT = 10;
export const DEFAULT_ROW_LIMIT = 500;
/** Plafond de sécurité pour les axes temporels et les requêtes du chatbot. */
export const MAX_RESULT_ROWS = 5000;

export function tableName(datasetId: string): string {
  return `ds_${datasetId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(v: string | number | boolean | null | undefined, col: ColumnSchema): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Valeur numérique invalide');
    return String(v);
  }
  const quoted = `'${v.replace(/'/g, "''")}'`;
  if (col.type === 'date') return `DATE ${quoted}`;
  if (col.type === 'number' || col.type === 'integer') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Valeur non numérique pour ${col.name} : ${v}`);
    return String(n);
  }
  return quoted;
}

function columnOf(meta: DatasetMeta, id: string): ColumnSchema {
  const col = meta.columns.find((c) => c.id === id);
  if (!col) throw new Error(`Colonne inconnue : ${id}`);
  return col;
}

function compileFilter(f: Filter, meta: DatasetMeta): string {
  const col = columnOf(meta, f.columnId);
  const c = ident(col.id);
  const lit = (v: Filter['value']) => literal(v, col);
  switch (f.op) {
    case 'isNull':
      return `${c} IS NULL`;
    case 'notNull':
      return `${c} IS NOT NULL`;
    case 'eq':
      return f.value === null ? `${c} IS NULL` : `${c} = ${lit(f.value)}`;
    case 'neq':
      // « différent de » conserve les nulls, conformément à la règle de prise en compte des nulls.
      return f.value === null ? `${c} IS NOT NULL` : `${c} IS DISTINCT FROM ${lit(f.value)}`;
    case 'gt':
      return `${c} > ${lit(f.value)}`;
    case 'gte':
      return `${c} >= ${lit(f.value)}`;
    case 'lt':
      return `${c} < ${lit(f.value)}`;
    case 'lte':
      return `${c} <= ${lit(f.value)}`;
    case 'between': {
      const [a, b] = f.values ?? [];
      return `${c} BETWEEN ${lit(a)} AND ${lit(b)}`;
    }
    case 'contains': {
      const needle = String(f.value ?? '').replace(/[\\%_]/g, (m) => `\\${m}`);
      return `CAST(${c} AS VARCHAR) ILIKE '%${needle.replace(/'/g, "''")}%' ESCAPE '\\'`;
    }
    case 'in':
    case 'notIn': {
      const vals = f.values ?? [];
      const nonNull = vals.filter((v) => v !== null);
      const hasNull = vals.length !== nonNull.length;
      const list = nonNull.length ? `${c} IN (${nonNull.map(lit).join(', ')})` : 'FALSE';
      const expr = hasNull ? `(${list} OR ${c} IS NULL)` : list;
      return f.op === 'in' ? expr : `NOT ${expr}`;
    }
  }
}

function groupExpr(g: GroupBy, meta: DatasetMeta): string {
  const col = columnOf(meta, g.columnId);
  if (col.type === 'date' && g.timeGrain && g.timeGrain !== 'day') {
    return `CAST(date_trunc('${g.timeGrain}', ${ident(col.id)}) AS DATE)`;
  }
  return ident(col.id);
}

function measureExpr(m: Measure, meta: DatasetMeta): string {
  if (m.fn === 'count') return 'COUNT(*)';
  if (!m.columnId) throw new Error(`La mesure ${m.fn} exige une colonne`);
  const c = ident(columnOf(meta, m.columnId).id);
  switch (m.fn) {
    case 'countValues':
      return `COUNT(${c})`;
    case 'countNull':
      return `COUNT(*) FILTER (WHERE ${c} IS NULL)`;
    case 'countDistinct':
      return `COUNT(DISTINCT ${c})`;
    case 'sum':
      return `CAST(SUM(${c}) AS DOUBLE)`;
    case 'avg':
      return `AVG(${c})`;
    case 'min':
      return `MIN(${c})`;
    case 'max':
      return `MAX(${c})`;
  }
}

const FN_LABELS: Record<Measure['fn'], string> = {
  count: 'Nombre de lignes',
  countValues: 'Nombre de valeurs',
  countNull: 'Nombre de vides',
  countDistinct: 'Valeurs distinctes',
  sum: 'Somme',
  avg: 'Moyenne',
  min: 'Minimum',
  max: 'Maximum',
};

export function measureLabel(m: Measure, meta: DatasetMeta): string {
  if (m.label) return m.label;
  if (m.fn === 'count' || !m.columnId) return FN_LABELS[m.fn];
  return `${FN_LABELS[m.fn]} – ${columnOf(meta, m.columnId).name}`;
}

export interface CompiledQuery {
  sql: string;
  columns: { key: string; label: string }[];
  /** Requêtes retournant le nombre de groupes distincts, pour savoir si groupLimit a tronqué. */
  groupCountSql: { sql: string; limit: number }[];
}

/** Un filtre en cours de saisie (sans valeur) est ignoré plutôt que de produire une requête fausse. */
export function isComplete(f: Filter): boolean {
  if (f.op === 'isNull' || f.op === 'notNull') return true;
  if (f.op === 'in' || f.op === 'notIn') return (f.values?.length ?? 0) > 0;
  if (f.op === 'between') return (f.values?.length ?? 0) === 2;
  return f.value !== undefined && f.value !== '';
}

/** Vue DuckDB d'un dashboard : le jeu de données restreint par les filtres du dashboard. */
export function dashboardViewName(dashboardId: string): string {
  return `dash_${dashboardId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/** SQL de création de la vue filtrée d'un dashboard (instruction de confiance, jamais issue du LLM). */
export function dashboardViewSql(dashboardId: string, meta: DatasetMeta, filters: Filter[]): string {
  const conds = filters.filter(isComplete).map((f) => compileFilter(f, meta));
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  return `CREATE OR REPLACE VIEW ${ident(dashboardViewName(dashboardId))} AS SELECT * FROM ${ident(tableName(meta.id))}${where}`;
}

export const OP_LABELS: Record<Filter['op'], string> = {
  eq: '=',
  neq: '≠',
  in: 'parmi',
  notIn: 'hors de',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'entre',
  contains: 'contient',
  isNull: 'est vide',
  notNull: 'n’est pas vide',
};

/**
 * Description lisible d'un filtre, envoyée au LLM et affichée dans le chat.
 * Pour une colonne sensible, la valeur filtrée est omise (elle ne doit pas quitter le navigateur).
 */
export function describeFilter(f: Filter, meta: DatasetMeta, { hideSensitive = false } = {}): string {
  const col = meta.columns.find((c) => c.id === f.columnId);
  const name = col?.name ?? f.columnId;
  const op = OP_LABELS[f.op];
  if (f.op === 'isNull' || f.op === 'notNull') return `${name} ${op}`;
  if (hideSensitive && col?.sensitive) return `${name} ${op} (valeur masquée)`;
  const show = (v: Filter['value']) => (v === null || v === undefined ? '(vide)' : `« ${String(v)} »`);
  if (f.op === 'between') return `${name} entre ${show(f.values?.[0])} et ${show(f.values?.[1])}`;
  if (f.op === 'in' || f.op === 'notIn') return `${name} ${op} ${(f.values ?? []).map(show).join(', ')}`;
  return `${name} ${op} ${show(f.value)}`;
}

export function compileQuery(spec: QuerySpec, meta: DatasetMeta, globalFilters: Filter[] = []): CompiledQuery {
  const filters = [...globalFilters, ...spec.filters].filter(isComplete).map((f) => compileFilter(f, meta));
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const base = `base AS (SELECT * FROM ${ident(tableName(meta.id))} ${where})`;

  // Mode lignes brutes.
  if (spec.groupBy.length === 0 && spec.measures.length === 0) {
    const cols = (spec.columns?.length ? spec.columns : meta.columns.map((c) => c.id)).map((id) => columnOf(meta, id));
    const order = (spec.sort ?? [])
      .map((s) => `${ident(columnOf(meta, s.by).id)} ${s.dir.toUpperCase()} NULLS LAST`)
      .join(', ');
    const limit = Math.min(spec.rowLimit ?? DEFAULT_ROW_LIMIT, MAX_RESULT_ROWS);
    return {
      sql: `WITH ${base} SELECT ${cols.map((c) => ident(c.id)).join(', ')} FROM base${order ? ` ORDER BY ${order}` : ''} LIMIT ${limit}`,
      columns: cols.map((c) => ({ key: c.id, label: c.name })),
      groupCountSql: [],
    };
  }

  const groupLimit = spec.groupLimit ?? DEFAULT_GROUP_LIMIT;
  const firstMeasure = spec.measures[0];
  const rankExpr = firstMeasure ? measureExpr(firstMeasure, meta) : 'COUNT(*)';

  const ctes = [base];
  const conditions: string[] = [];
  const groupCountSql: CompiledQuery['groupCountSql'] = [];

  // Chaque dimension catégorielle est limitée à ses N groupes les plus importants
  // (selon la première mesure), sans regrouper le reste dans « Autres ».
  spec.groupBy.forEach((g, i) => {
    const col = columnOf(meta, g.columnId);
    if (col.type === 'date') return; // L'axe temporel n'est jamais tronqué.
    const expr = groupExpr(g, meta);
    ctes.push(
      `top${i} AS (SELECT ${expr} AS k FROM base GROUP BY 1 ORDER BY ${rankExpr} DESC NULLS LAST LIMIT ${groupLimit})`,
    );
    conditions.push(`EXISTS (SELECT 1 FROM top${i} WHERE top${i}.k IS NOT DISTINCT FROM ${expr})`);
    groupCountSql.push({
      sql: `WITH ${base} SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${expr} FROM base)`,
      limit: groupLimit,
    });
  });

  const selectGroups = spec.groupBy.map((g, i) => `${groupExpr(g, meta)} AS ${ident(`g${i}`)}`);
  const selectMeasures = spec.measures.map((m) => `${measureExpr(m, meta)} AS ${ident(m.id)}`);
  const groupClause = spec.groupBy.length ? `GROUP BY ${spec.groupBy.map((_, i) => i + 1).join(', ')}` : '';

  const validKeys = new Set([...spec.groupBy.map((_, i) => `g${i}`), ...spec.measures.map((m) => m.id)]);
  let order: string;
  if (spec.sort?.length) {
    order = spec.sort
      .filter((s) => validKeys.has(s.by))
      .map((s) => `${ident(s.by)} ${s.dir.toUpperCase()} NULLS LAST`)
      .join(', ');
  } else {
    // Par défaut : temps croissant, sinon première mesure décroissante.
    const temporalIdx = spec.groupBy.findIndex((g) => columnOf(meta, g.columnId).type === 'date');
    order =
      temporalIdx >= 0
        ? `${ident(`g${temporalIdx}`)} ASC NULLS LAST`
        : firstMeasure
          ? `${ident(firstMeasure.id)} DESC NULLS LAST`
          : '';
  }

  const sql =
    `WITH ${ctes.join(', ')} ` +
    `SELECT ${[...selectGroups, ...selectMeasures].join(', ')} FROM base ` +
    (conditions.length ? `WHERE ${conditions.join(' AND ')} ` : '') +
    `${groupClause}${order ? ` ORDER BY ${order}` : ''} LIMIT ${MAX_RESULT_ROWS}`;

  return {
    sql,
    columns: [
      ...spec.groupBy.map((g, i) => {
        const col = columnOf(meta, g.columnId);
        return { key: `g${i}`, label: g.timeGrain && g.timeGrain !== 'day' ? `${col.name} (${g.timeGrain})` : col.name };
      }),
      ...spec.measures.map((m) => ({ key: m.id, label: measureLabel(m, meta) })),
    ],
    groupCountSql,
  };
}

// ---------------------------------------------------------------------------
// Validation du SQL généré par le chatbot
// ---------------------------------------------------------------------------

const FORBIDDEN = [
  'attach', 'detach', 'copy', 'export', 'import', 'install', 'load', 'pragma', 'set', 'reset', 'call',
  'create', 'insert', 'update', 'delete', 'drop', 'alter', 'truncate', 'vacuum', 'checkpoint', 'use',
  'read_csv', 'read_csv_auto', 'read_json', 'read_json_auto', 'read_ndjson', 'read_parquet', 'read_text',
  'read_blob', 'parquet_scan', 'glob', 'sniff_csv', 'query_table', 'query',
];

/**
 * Le SQL produit par le LLM est traité comme non fiable : une seule requête
 * SELECT/WITH, sans accès aux fichiers ni au réseau (sinon une donnée piégée
 * pourrait amener le modèle à exfiltrer des valeurs via une URL).
 */
export function validateReadOnlySql(sql: string): string {
  // Retire commentaires et chaînes avant l'analyse des mots-clés.
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");

  const trimmed = stripped.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) throw new Error('Une seule instruction SQL est permise.');
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error('Seules les requêtes SELECT sont permises.');
  if (/https?:|s3:|gcs:|azure:|file:/i.test(sql)) throw new Error('Les accès réseau ou fichiers sont interdits.');

  // Un identifiant entre guillemets suivi de « ( » est un appel de fonction : on le vérifie aussi.
  for (const m of trimmed.matchAll(/"((?:[^"]|"")*)"\s*\(/g)) {
    if (FORBIDDEN.includes(m[1]!.toLowerCase())) throw new Error(`Fonction interdite : ${m[1]}`);
  }
  // Les alias entre guillemets (« "Montant total" ») ne doivent pas déclencher de faux positifs.
  const unquoted = trimmed.replace(/"(?:[^"]|"")*"/g, '""');
  const words = new Set(unquoted.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
  const hit = FORBIDDEN.find((w) => words.has(w));
  if (hit) throw new Error(`Mot-clé interdit dans la requête : ${hit.toUpperCase()}`);

  return sql.trim().replace(/;\s*$/, '');
}
