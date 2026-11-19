import type { CellValue } from '../../../shared/types';

const numberFmt = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 2 });

export const NULL_LABEL = '(vide)';

export function fmt(v: CellValue | undefined): string {
  if (v === null || v === undefined) return NULL_LABEL;
  if (typeof v === 'number') return numberFmt.format(v);
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  return v;
}

/**
 * Valeur d'un indicateur suivie de son unité, séparées par une espace insécable (usage québécois :
 * « 731,8 $ », « 12 % », « 45 kg »). Pas d'unité sur une valeur vide.
 */
export function kpiText(v: CellValue | undefined, suffix?: string | null): string {
  const unit = suffix?.trim();
  return unit && v !== null && v !== undefined ? `${fmt(v)} ${unit}` : fmt(v);
}

export function fmtInt(n: number): string {
  return new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 0 }).format(n);
}
