import type { CellValue } from '../../../shared/types';

const numberFmt = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 2 });

export const NULL_LABEL = '(vide)';

export function fmt(v: CellValue | undefined): string {
  if (v === null || v === undefined) return NULL_LABEL;
  if (typeof v === 'number') return numberFmt.format(v);
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  return v;
}

export function fmtInt(n: number): string {
  return new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 0 }).format(n);
}
