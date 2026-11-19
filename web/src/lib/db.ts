/**
 * Moteur de requêtes : DuckDB-WASM, qui tourne dans son propre Web Worker.
 * Les données ne transitent jamais par le state React : seuls les résultats
 * (déjà agrégés) en ressortent.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import { DataType, type Table } from 'apache-arrow';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import type { CellValue, ColumnSchema, DatasetMeta, Filter, QueryResult, QuerySpec } from '../../../shared/types';
import { compileQuery, dashboardViewSql, ident, MAX_RESULT_ROWS, tableName, validateReadOnlySql } from './sql';

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: duckdb_wasm, mainWorker: mvp_worker },
  eh: { mainModule: duckdb_wasm_eh, mainWorker: eh_worker },
};

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;
const loaded = new Set<string>();

function getDb(): Promise<duckdb.AsyncDuckDB> {
  dbPromise ??= (async () => {
    const bundle = await duckdb.selectBundle(BUNDLES);
    const worker = new Worker(bundle.mainWorker!);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return db;
  })();
  return dbPromise;
}

const SQL_TYPES: Record<ColumnSchema['type'], string> = {
  string: 'VARCHAR',
  number: 'DOUBLE',
  integer: 'BIGINT',
  boolean: 'BOOLEAN',
  date: 'DATE',
};

/** Charge (ou recharge) un jeu de données normalisé dans une table DuckDB. */
export async function loadDataset(meta: DatasetMeta, rows: CellValue[][]): Promise<void> {
  const db = await getDb();
  const conn = await db.connect();
  const fileName = `${meta.id}.json`;
  try {
    const objects = rows.map((r) => Object.fromEntries(meta.columns.map((c, i) => [c.id, r[i] ?? null])));
    await db.registerFileText(fileName, JSON.stringify(objects));
    const columns = meta.columns.map((c) => `'${c.id}': '${SQL_TYPES[c.type]}'`).join(', ');
    await conn.query(
      `CREATE OR REPLACE TABLE ${ident(tableName(meta.id))} AS ` +
        `SELECT * FROM read_json('${fileName}', format = 'array', columns = {${columns}})`,
    );
    loaded.add(meta.id);
  } finally {
    await conn.close();
    // Le fichier virtuel est retiré : les requêtes du chatbot ne peuvent plus le lire directement.
    await db.dropFile(fileName);
  }
}

/** Dernier SQL de création appliqué par vue, pour ne recréer la vue que si les filtres changent. */
const views = new Map<string, Promise<void>>();

/**
 * Crée ou met à jour la vue filtrée d'un dashboard (`dash_<id>`). Le chat du dashboard et
 * les widgets épinglés depuis le chat l'interrogent : ils suivent ainsi les filtres du dashboard.
 * Le jeu de données doit déjà être chargé.
 */
export function ensureDashboardView(dashboardId: string, meta: DatasetMeta, filters: Filter[]): Promise<void> {
  const sql = dashboardViewSql(dashboardId, meta, filters);
  const key = `${dashboardId}\u0000${sql}`;
  let p = views.get(key);
  if (!p) {
    p = runSql(sql).then(() => undefined);
    p.catch(() => views.delete(key));
    // Une seule entrée par dashboard : l'ancienne définition n'est plus valide.
    for (const k of views.keys()) if (k.startsWith(`${dashboardId}\u0000`)) views.delete(k);
    views.set(key, p);
  }
  return p;
}

/** Oublie les vues de dashboard déjà créées : elles seront recréées à la prochaine requête (ex. après un remplacement des lignes). */
export function forgetDashboardViews(): void {
  views.clear();
}

export function isLoaded(datasetId: string): boolean {
  return loaded.has(datasetId);
}

export async function dropDataset(datasetId: string): Promise<void> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    await conn.query(`DROP TABLE IF EXISTS ${ident(tableName(datasetId))}`);
    loaded.delete(datasetId);
  } finally {
    await conn.close();
  }
}

/** Convertit les types Arrow (BigInt, dates en ms, décimaux) en valeurs JSON simples. */
function arrowToRows(table: Table): Record<string, CellValue>[] {
  const fields = table.schema.fields;
  return table.toArray().map((row) => {
    const obj: Record<string, CellValue> = {};
    const json = row.toJSON() as Record<string, unknown>;
    for (const f of fields) {
      const v = json[f.name];
      if (v === null || v === undefined) obj[f.name] = null;
      else if (DataType.isDate(f.type) || DataType.isTimestamp(f.type)) {
        obj[f.name] = new Date(Number(v)).toISOString().slice(0, 10);
      } else if (DataType.isDecimal(f.type)) {
        obj[f.name] = Number(String(v)) / 10 ** f.type.scale;
      } else if (typeof v === 'bigint') obj[f.name] = Number(v);
      else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') obj[f.name] = v;
      else obj[f.name] = String(v);
    }
    return obj;
  });
}

export async function runSql(sql: string): Promise<Record<string, CellValue>[]> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    return arrowToRows(await conn.query(sql));
  } finally {
    await conn.close();
  }
}

export async function runSpec(spec: QuerySpec, meta: DatasetMeta, globalFilters: Filter[] = []): Promise<QueryResult> {
  const compiled = compileQuery(spec, meta, globalFilters);
  const rows = await runSql(compiled.sql);
  let truncated = false;
  for (const check of compiled.groupCountSql) {
    const [res] = await runSql(check.sql);
    if (Number(res?.n ?? 0) > check.limit) truncated = true;
  }
  return { columns: compiled.columns, rows, truncated, sql: compiled.sql };
}

/** Exécute une requête générée par le chatbot, après validation. */
export async function runUntrustedSql(sql: string): Promise<QueryResult> {
  const safe = validateReadOnlySql(sql);
  const wrapped = `SELECT * FROM (${safe}) AS q LIMIT ${MAX_RESULT_ROWS + 1}`;
  const rows = await runSql(wrapped);
  const truncated = rows.length > MAX_RESULT_ROWS;
  const kept = rows.slice(0, MAX_RESULT_ROWS);
  const keys = kept[0] ? Object.keys(kept[0]) : [];
  return { columns: keys.map((k) => ({ key: k, label: k })), rows: kept, truncated, sql: safe };
}
