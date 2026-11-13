/**
 * Profilage des colonnes : typage heuristique, rôle, statistiques,
 * échantillons masqués pour l'IA et normalisation des valeurs.
 */
import type { CellValue, ColumnRole, ColumnSchema, ColumnStats, ColumnType } from '../../../shared/types';
import { dateObjectToIso, detectDatePattern, normalizeDate } from './dates';
import type { RawCell, RawTable } from './ingest';

const NULL_TOKENS = new Set(['', 'null', 'NULL', 'n/a', 'N/A', '#N/A', 'NA', '-', '—']);
const TRUE_TOKENS = new Set(['true', 'vrai', 'oui', 'yes', 'o', 'y']);
const FALSE_TOKENS = new Set(['false', 'faux', 'non', 'no', 'n']);
const MATCH_THRESHOLD = 0.95;

export function isNullish(v: RawCell): boolean {
  return v === null || (typeof v === 'string' && NULL_TOKENS.has(v.trim()));
}

/**
 * Convertit « 1 234,56 $ », « 1,234.56 », « 12,5 % » en nombre.
 * Règle québécoise : une virgule seule est décimale, sauf motif 1,234,567.
 */
export function parseNumber(v: RawCell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/[\s  ]/g, '').replace(/[$€%]/g, '');
  if (s === '' || !/^[-+]?[\d.,]+$/.test(s)) return null;
  // Zéros initiaux (« 00123 ») : identifiant ou code, pas un nombre.
  if (/^[-+]?0\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandSep = decimalSep === ',' ? '.' : ',';
    s = s.split(thousandSep).join('').replace(decimalSep, '.');
  } else if (lastComma >= 0) {
    s = /^[-+]?\d{1,3}(,\d{3}){2,}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseBoolean(v: RawCell): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (TRUE_TOKENS.has(s)) return true;
  if (FALSE_TOKENS.has(s)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Renseignements personnels
// ---------------------------------------------------------------------------

const SENSITIVE_NAME = /(^|[^a-z])(nom|pr[ée]nom|name|courriel|e-?mail|t[ée]l[ée]phone|phone|cell|adresse|address|nas|sin|naissance|birth|salaire|salary|matricule|employ[ée]|sant[ée]|diagnostic)/i;

const MASKS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[courriel]'],
  [/\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/g, '[code postal]'],
  [/\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/g, '[NAS?]'],
  [/(\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, '[téléphone]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[carte?]'],
];

export function maskValue(s: string): string {
  return MASKS.reduce((acc, [re, label]) => acc.replace(re, label), s);
}

export function looksSensitive(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

// ---------------------------------------------------------------------------
// Inférence heuristique
// ---------------------------------------------------------------------------

export interface HeuristicColumn {
  schema: ColumnSchema;
  /** Échantillon masqué destiné à l'IA (vide si colonne sensible). */
  samples: string[];
  dateAmbiguous: boolean;
}

function inferType(values: RawCell[]): { type: ColumnType; datePattern: string | null; ambiguous: boolean } {
  const present = values.filter((v) => !isNullish(v));
  if (present.length === 0) return { type: 'string', datePattern: null, ambiguous: false };
  const ratio = (pred: (v: RawCell) => boolean) => present.filter(pred).length / present.length;

  if (ratio((v) => v instanceof Date) >= MATCH_THRESHOLD) {
    return { type: 'date', datePattern: null, ambiguous: false };
  }
  if (ratio((v) => typeof v === 'boolean' || parseBoolean(v) !== null) >= MATCH_THRESHOLD) {
    // « o / n » seuls sont trop ambigus pour conclure sans l'IA, mais on accepte.
    return { type: 'boolean', datePattern: null, ambiguous: false };
  }
  const strings = present.filter((v): v is string => typeof v === 'string').slice(0, 500);
  if (strings.length >= present.length * MATCH_THRESHOLD) {
    const detected = detectDatePattern(strings);
    if (detected) return { type: 'date', datePattern: detected.pattern, ambiguous: detected.ambiguous };
  }
  if (ratio((v) => parseNumber(v) !== null) >= MATCH_THRESHOLD) {
    const allInt = present.every((v) => {
      const n = parseNumber(v);
      return n === null || Number.isInteger(n);
    });
    return { type: allInt ? 'integer' : 'number', datePattern: null, ambiguous: false };
  }
  return { type: 'string', datePattern: null, ambiguous: false };
}

const ID_NAME = /(^id$|^id[_ ]|[_ ]id$|^no[_ .]|^num|num[ée]ro|^code|matricule|^cl[ée]$)/i;

function inferRole(name: string, type: ColumnType, distinct: number, present: number, avgLength: number): ColumnRole {
  const distinctRatio = present === 0 ? 0 : distinct / present;
  if (type === 'date') return 'temporal';
  if (type === 'boolean') return 'dimension';
  if (ID_NAME.test(name)) return 'identifier';
  if (type === 'number' || type === 'integer') {
    if (type === 'integer' && distinctRatio > 0.98 && present > 20) return 'identifier';
    // Peu de valeurs distinctes (ex. année, note de 1 à 5) : plutôt une dimension.
    return distinct <= 12 && present > 50 ? 'dimension' : 'measure';
  }
  if (avgLength > 60) return 'text';
  if (distinctRatio > 0.9 && present > 20) return 'identifier';
  return 'dimension';
}

export function profileTable(table: RawTable): HeuristicColumn[] {
  return table.headers.map((name, i) => {
    const raw = table.rows.map((r) => r[i] ?? null);
    const { type, datePattern, ambiguous } = inferType(raw);
    const present = raw.filter((v) => !isNullish(v));
    const distinctStrings = new Set(present.map((v) => (v instanceof Date ? v.toISOString() : String(v))));
    const avgLength =
      present.length === 0 ? 0 : present.reduce((acc: number, v) => acc + String(v).length, 0) / present.length;
    const sensitive = looksSensitive(name);

    const schema: ColumnSchema = {
      id: `c${i}`,
      name,
      type,
      role: inferRole(name, type, distinctStrings.size, present.length, avgLength),
      datePattern,
      sensitive,
      source: 'heuristic',
    };

    const samples = sensitive
      ? []
      : [...distinctStrings].slice(0, 12).map((s) => maskValue(s).slice(0, 80));

    return { schema, samples, dateAmbiguous: ambiguous };
  });
}

// ---------------------------------------------------------------------------
// Normalisation et statistiques
// ---------------------------------------------------------------------------

export function normalizeCell(v: RawCell, col: ColumnSchema): CellValue {
  if (isNullish(v)) return null;
  switch (col.type) {
    case 'number':
      return parseNumber(v);
    case 'integer': {
      const n = parseNumber(v);
      return n === null ? null : Math.round(n);
    }
    case 'boolean':
      return parseBoolean(v);
    case 'date':
      if (v instanceof Date) return dateObjectToIso(v);
      return col.datePattern ? normalizeDate(v, col.datePattern) : normalizeDate(v, 'YYYY-MM-DD');
    default:
      return v instanceof Date ? dateObjectToIso(v) : String(v).trim();
  }
}

/** Retourne les lignes normalisées et le nombre de valeurs rejetées par colonne. */
export function normalizeRows(table: RawTable, columns: ColumnSchema[]) {
  const rejected = new Array<number>(columns.length).fill(0);
  const rows = table.rows.map((r) =>
    columns.map((col, i) => {
      const raw = r[i] ?? null;
      const value = normalizeCell(raw, col);
      if (value === null && !isNullish(raw)) rejected[i]!++;
      return value;
    }),
  );
  return { rows, rejected };
}

export function computeStats(rows: CellValue[][], columns: ColumnSchema[]): ColumnSchema[] {
  return columns.map((col, i) => {
    const values = rows.map((r) => r[i] ?? null);
    const present = values.filter((v): v is Exclude<CellValue, null> => v !== null);
    const counts = new Map<string, number>();
    for (const v of present) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);

    const stats: ColumnStats = {
      count: values.length,
      nullCount: values.length - present.length,
      distinctCount: counts.size,
      topValues: [],
    };
    if (col.type === 'number' || col.type === 'integer') {
      const nums = present as number[];
      if (nums.length) {
        stats.min = nums.reduce((a, b) => (b < a ? b : a));
        stats.max = nums.reduce((a, b) => (b > a ? b : a));
      }
    } else if (col.type === 'date') {
      const sorted = (present as string[]).slice().sort();
      stats.min = sorted[0];
      stats.max = sorted[sorted.length - 1];
    }
    if (col.role === 'dimension' || col.type === 'boolean') {
      stats.topValues = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([value, count]) => ({ value, count }));
    }
    return { ...col, stats };
  });
}
