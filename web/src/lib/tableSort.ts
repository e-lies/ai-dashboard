/**
 * Tri des tableaux de résultats par colonne (clic sur l'en-tête).
 * Cycle : croissant → décroissant → aucun tri (ordre de la requête).
 */
import type { CellValue, SortSpec } from '../../../shared/types';

export function nextSort(current: SortSpec | null, key: string): SortSpec | null {
  if (current?.by !== key) return { by: key, dir: 'asc' };
  if (current.dir === 'asc') return { by: key, dir: 'desc' };
  return null;
}

const collator = new Intl.Collator('fr-CA', { numeric: true, sensitivity: 'base' });

/** Compare deux cellules : nombres numériquement, texte selon l'ordre français. Les vides restent toujours à la fin. */
export function compareCells(a: CellValue | undefined, b: CellValue | undefined): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/** Tri stable d'un résultat déjà calculé ; les valeurs vides sont placées à la fin, quel que soit le sens. */
export function sortRows<T extends Record<string, CellValue>>(rows: T[], sort: SortSpec | null): T[] {
  if (!sort) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const isEmpty = (v: CellValue | undefined) => v === null || v === undefined || v === '';
  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      const a = x.row[sort.by];
      const b = y.row[sort.by];
      if (isEmpty(a) || isEmpty(b)) return isEmpty(a) === isEmpty(b) ? x.i - y.i : isEmpty(a) ? 1 : -1;
      return sign * compareCells(a, b) || x.i - y.i;
    })
    .map((x) => x.row);
}
