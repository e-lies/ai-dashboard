/**
 * Mise à jour des données d'un jeu existant à partir d'un nouveau fichier.
 *
 * Le schéma actuel est conservé tel quel (ids, types, formats de date, rôles,
 * descriptions, colonnes sensibles) : les dashboards et widgets qui s'y réfèrent
 * restent valides. Le fichier n'est accepté que si chaque colonne du schéma y
 * figure ; les colonnes en trop sont ignorées.
 */
import type { CellValue, ColumnSchema, DatasetMeta } from '../../../shared/types';
import { normalizeText } from './fuzzy';
import { guessHeaderRow, toTable, type RawTable, type RawWorkbook } from './ingest';
import { computeStats, normalizeRows } from './profile';

/** Lignes examinées pour trouver la ligne d'en-tête (les fichiers ont parfois un titre au-dessus). */
const HEADER_SCAN = 20;

export interface ColumnMatch {
  /** Pour chaque colonne du schéma, l'index de la colonne correspondante dans le fichier (-1 si absente). */
  indexes: number[];
  /** Noms des colonnes du schéma absentes du fichier. */
  missing: string[];
  /** Colonnes du fichier qui ne font pas partie du schéma (ignorées). */
  extra: string[];
}

/**
 * Retrouve chaque colonne du schéma parmi les en-têtes du fichier : nom identique d'abord,
 * puis à la casse, aux accents et aux espaces près. Chaque en-tête ne sert qu'une fois.
 */
export function matchColumns(headers: string[], columns: ColumnSchema[]): ColumnMatch {
  const used = new Set<number>();
  const find = (pred: (h: string) => boolean) => headers.findIndex((h, i) => !used.has(i) && pred(h));
  const indexes = columns.map(() => -1);

  // Deux passes, pour qu'une correspondance exacte ne soit pas « volée » par une approximative.
  columns.forEach((c, k) => {
    const i = find((h) => h.trim() === c.name.trim());
    if (i >= 0) {
      indexes[k] = i;
      used.add(i);
    }
  });
  columns.forEach((c, k) => {
    if (indexes[k]! >= 0) return;
    const i = find((h) => normalizeText(h) === normalizeText(c.name));
    if (i >= 0) {
      indexes[k] = i;
      used.add(i);
    }
  });

  return {
    indexes,
    missing: columns.filter((_, k) => indexes[k] === -1).map((c) => c.name),
    extra: headers.filter((_, i) => !used.has(i)),
  };
}

interface Source {
  sheetName?: string;
  table: RawTable;
  match: ColumnMatch;
}

/**
 * Cherche l'onglet et la ligne d'en-tête où figurent toutes les colonnes du schéma (l'onglet d'origine
 * d'abord). À défaut, retourne la meilleure tentative, pour indiquer les colonnes manquantes.
 */
export function findSource(wb: RawWorkbook, columns: ColumnSchema[], preferredSheet?: string): Source {
  const sheets = [...wb.sheets].sort((a, b) => Number(b.name === preferredSheet) - Number(a.name === preferredSheet));
  let best: Source | null = null;
  for (const sheet of sheets) {
    const guessed = guessHeaderRow(sheet.matrix);
    const rows = [guessed, ...Array.from({ length: Math.min(HEADER_SCAN, sheet.matrix.length) }, (_, i) => i)];
    for (const headerRow of new Set(rows)) {
      const table = toTable(sheet.matrix, headerRow);
      const match = matchColumns(table.headers, columns);
      const candidate = { sheetName: wb.sheets.length > 1 ? sheet.name : undefined, table, match };
      if (!match.missing.length) return candidate;
      if (!best || match.missing.length < best.match.missing.length) best = candidate;
    }
  }
  return best ?? { table: { headers: [], rows: [] }, match: matchColumns([], columns) };
}

export type RefreshPlan =
  | { ok: false; missing: string[]; sheetName?: string }
  | {
      ok: true;
      meta: DatasetMeta;
      rows: CellValue[][];
      /** Valeurs non convertibles selon le type du schéma (elles deviennent vides). */
      rejected: { column: string; count: number }[];
      /** Colonnes du fichier ignorées, absentes du schéma. */
      extra: string[];
    };

/** Prépare le remplacement des lignes d'un jeu de données, sans rien modifier. */
export function prepareRefresh(meta: DatasetMeta, wb: RawWorkbook, now = new Date()): RefreshPlan {
  const { sheetName, table, match } = findSource(wb, meta.columns, meta.sheetName);
  if (match.missing.length) return { ok: false, missing: match.missing, sheetName };

  // Colonnes remises dans l'ordre du schéma, pour la normalisation et le chargement.
  const ordered: RawTable = {
    headers: meta.columns.map((c) => c.name),
    rows: table.rows.map((r) => match.indexes.map((i) => r[i] ?? null)),
  };
  const { rows, rejected } = normalizeRows(ordered, meta.columns);

  return {
    ok: true,
    meta: {
      ...meta,
      fileName: wb.fileName,
      sheetName,
      rowCount: rows.length,
      columns: computeStats(rows, meta.columns),
      updatedAt: now.toISOString(),
    },
    rows,
    rejected: meta.columns
      .map((c, i) => ({ column: c.name, count: rejected[i] ?? 0 }))
      .filter((r) => r.count > 0),
    extra: match.extra,
  };
}
