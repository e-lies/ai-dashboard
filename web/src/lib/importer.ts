/**
 * Orchestration de l'import : matrice brute → profilage heuristique →
 * raffinement par l'IA locale (facultatif) → normalisation → statistiques.
 */
import { nanoid } from 'nanoid';
import type { CellValue, ColumnSchema, DatasetMeta } from '../../../shared/types';
import { api } from './api';
import type { RawTable } from './ingest';
import { computeStats, isNullish, normalizeRows, profileTable, type HeuristicColumn } from './profile';

/**
 * Envoie à l'IA locale (jamais à l'IA infonuagique) le nom des colonnes et un échantillon masqué ;
 * jamais de lignes complètes, ni d'échantillon pour les colonnes sensibles.
 */
export async function refineWithAi(
  datasetName: string,
  table: RawTable,
  heuristics: HeuristicColumn[],
): Promise<ColumnSchema[]> {
  const res = await api.inferTypes({
    datasetName,
    columns: heuristics.map((h) => ({
      id: h.schema.id,
      name: h.schema.name,
      heuristicType: h.schema.type,
      distinctCount: new Set(table.rows.map((r) => String(r[Number(h.schema.id.slice(1))] ?? ''))).size,
      nullRatio:
        table.rows.length === 0
          ? 0
          : table.rows.filter((r) => isNullish(r[Number(h.schema.id.slice(1))] ?? null)).length / table.rows.length,
      samples: h.samples,
    })),
  });

  const byId = new Map(res.columns.map((c) => [c.id, c]));
  return heuristics.map(({ schema }) => {
    const ai = byId.get(schema.id);
    if (!ai) return schema;
    return {
      ...schema,
      type: ai.type,
      role: ai.role,
      datePattern: ai.type === 'date' ? (ai.datePattern ?? schema.datePattern) : null,
      // Une colonne repérée comme sensible par l'heuristique le reste.
      sensitive: schema.sensitive || ai.sensitive,
      description: ai.description,
      source: 'ai',
    };
  });
}

export function profile(table: RawTable) {
  return profileTable(table);
}

export interface BuiltDataset {
  meta: DatasetMeta;
  rows: CellValue[][];
  /** Nombre de valeurs qui n'ont pas pu être converties, par id de colonne. */
  rejected: Record<string, number>;
}

export function buildDataset(
  name: string,
  fileName: string,
  sheetName: string | undefined,
  table: RawTable,
  columns: ColumnSchema[],
): BuiltDataset {
  const { rows, rejected } = normalizeRows(table, columns);
  const meta: DatasetMeta = {
    id: nanoid(10),
    name,
    fileName,
    sheetName,
    rowCount: rows.length,
    columns: computeStats(rows, columns),
    createdAt: new Date().toISOString(),
  };
  return {
    meta,
    rows,
    rejected: Object.fromEntries(columns.map((c, i) => [c.id, rejected[i] ?? 0])),
  };
}
