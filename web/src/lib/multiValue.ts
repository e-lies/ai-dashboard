/**
 * Logique de la sélection multiple de valeurs (filtres « parmi » et « hors de »).
 * Les options sont les valeurs distinctes de la colonne, en texte ; les valeurs
 * choisies sont typées selon la colonne (nombre, texte, booléen) ou nulles.
 */
import type { ColumnSchema, Filter } from '../../../shared/types';
import { normalizeText } from './fuzzy';

export type FilterValue = NonNullable<Filter['values']>[number];

/** Libellé de la valeur nulle, dans les listes comme à la saisie. */
export const EMPTY_LABEL = '(vide)';

/** Nombre maximal d'options affichées à la fois ; au-delà, l'utilisateur affine sa recherche. */
export const MAX_OPTIONS = 200;

/** Convertit une saisie selon le type de la colonne. « (vide) » désigne la valeur nulle. */
export function parseInput(raw: string, col: ColumnSchema): FilterValue {
  const s = raw.trim();
  if (s === EMPTY_LABEL) return null;
  if (col.type === 'number' || col.type === 'integer') {
    const n = Number(s.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  if (col.type === 'boolean') return /^(oui|vrai|true|1)$/i.test(s);
  return s;
}

/** Clé de comparaison entre une valeur choisie et une option (texte issu de DuckDB). */
export const valueKey = (v: FilterValue): string => (v === null ? '\u0000' : String(v));

/** Découpe une saisie « a ; b ; c » en valeurs typées, sans doublons ni vides. */
export function splitInput(raw: string, col: ColumnSchema): FilterValue[] {
  const out: FilterValue[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(';')) {
    if (!part.trim()) continue;
    const v = parseInput(part, col);
    // Un nombre illisible donne null : on ne l'ajoute que si l'utilisateur a bien écrit « (vide) ».
    if (v === null && part.trim() !== EMPTY_LABEL) continue;
    const k = valueKey(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

/**
 * Remplace une valeur texte saisie par la valeur réelle de la colonne qui ne s'en distingue que par la casse,
 * les accents ou la ponctuation (« gaspe » → « Gaspé ») : le filtre compare les valeurs exactement.
 */
export function resolveTyped(values: FilterValue[], options: string[]): FilterValue[] {
  const byNorm = new Map<string, string>();
  for (const o of options) {
    const k = normalizeText(o);
    if (!byNorm.has(k)) byNorm.set(k, o);
  }
  return values.map((v) => (typeof v === 'string' && !options.includes(v) ? (byNorm.get(normalizeText(v)) ?? v) : v));
}

/** Ajoute ou retire une valeur de la sélection. */
export function toggleValue(selected: FilterValue[], v: FilterValue): FilterValue[] {
  const k = valueKey(v);
  return selected.some((x) => valueKey(x) === k) ? selected.filter((x) => valueKey(x) !== k) : [...selected, v];
}

/** Ajoute des valeurs à la sélection, sans doublons. */
export function addValues(selected: FilterValue[], values: FilterValue[]): FilterValue[] {
  const keys = new Set(selected.map(valueKey));
  return [...selected, ...values.filter((v) => !keys.has(valueKey(v)) && keys.add(valueKey(v)))];
}

const collator = new Intl.Collator('fr-CA', { numeric: true, sensitivity: 'base' });

/** Trie les options : numériquement pour les nombres, alphabétiquement (à la française) sinon. */
export function sortOptions(options: string[], col: ColumnSchema): string[] {
  const numeric = col.type === 'number' || col.type === 'integer';
  return [...options].sort((a, b) => (numeric ? Number(a) - Number(b) : collator.compare(a, b)));
}

/**
 * Options correspondant à la recherche (sans accents ni casse, par inclusion), plafonnées à MAX_OPTIONS.
 * La valeur nulle « (vide) » est toujours proposée en tête quand elle correspond.
 */
export function matchOptions(options: string[], query: string): { items: (string | null)[]; more: number } {
  const q = normalizeText(query);
  const hit = (s: string) => !q || normalizeText(s).includes(q);
  const all: (string | null)[] = [...(hit(EMPTY_LABEL) ? [null] : []), ...options.filter(hit)];
  return { items: all.slice(0, MAX_OPTIONS), more: Math.max(0, all.length - MAX_OPTIONS) };
}
