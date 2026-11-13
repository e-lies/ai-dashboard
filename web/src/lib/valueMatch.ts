/**
 * Vérifie que les valeurs texte utilisées par le SQL du chatbot existent dans les données
 * et, sinon, cherche les valeurs réelles les plus proches. Tout se passe dans DuckDB local.
 */
import type { ChatPlanResponse } from '../../../shared/contracts';
import type { ColumnSchema, DatasetMeta } from '../../../shared/types';
import { runSql } from './db';
import { findCloseValues, normalizeText, pickAutoCorrection, type CloseValue } from './fuzzy';
import { ident, tableName } from './sql';

/** Plafond de valeurs distinctes examinées par colonne. */
const MAX_DISTINCT = 20_000;

export interface LiteralCheck {
  column: ColumnSchema;
  /** Valeur telle qu'écrite dans le SQL. */
  requested: string;
  /** Correction sûre, appliquée sans demander. */
  auto: string | null;
  /** Valeurs proches à proposer lorsqu'aucune correction n'est sûre. */
  close: CloseValue[];
}

const distinctCache = new Map<string, Promise<string[]>>();

function distinctValues(meta: DatasetMeta, col: ColumnSchema): Promise<string[]> {
  // Les lignes d'un jeu de données ne changent pas après l'import.
  const key = `${meta.id}:${col.id}`;
  let p = distinctCache.get(key);
  if (!p) {
    const c = ident(col.id);
    p = runSql(
      `SELECT DISTINCT CAST(${c} AS VARCHAR) AS v FROM ${ident(tableName(meta.id))} WHERE ${c} IS NOT NULL LIMIT ${MAX_DISTINCT}`,
    ).then((rows) => rows.map((r) => String(r.v)));
    p.catch(() => distinctCache.delete(key));
    distinctCache.set(key, p);
  }
  return p;
}

/**
 * Retourne seulement les valeurs absentes des données. La comparaison est exacte, comme dans le SQL :
 * « montréal » pour « Montréal » est une absence, corrigée automatiquement (score 1).
 */
export async function checkLiterals(
  literals: ChatPlanResponse['literals'],
  meta: DatasetMeta,
): Promise<LiteralCheck[]> {
  const out: LiteralCheck[] = [];
  const seen = new Set<string>();
  for (const lit of literals) {
    const column = meta.columns.find((c) => c.id === lit.columnId);
    if (!column || column.type !== 'string') continue;
    const key = `${lit.columnId}\u0000${lit.value}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const values = await distinctValues(meta, column);
    if (values.includes(lit.value) || !normalizeText(lit.value)) continue;

    const close = findCloseValues(lit.value, values);
    out.push({ column, requested: lit.value, auto: pickAutoCorrection(close), close });
  }
  return out;
}
