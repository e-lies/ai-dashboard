/**
 * Normalisation des dates en AAAA-MM-JJ.
 *
 * Le format source (ex. « DD/MM/YYYY ») est détecté par heuristique ou par l'IA,
 * puis converti ici en expression régulière. Jetons reconnus : YYYY, YY, MM, M, DD, D.
 */

export const KNOWN_PATTERNS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD-MM-YYYY',
  'MM-DD-YYYY',
  'DD.MM.YYYY',
  'DD/MM/YY',
  'MM/DD/YY',
] as const;

interface CompiledPattern {
  regex: RegExp;
  order: ('Y' | 'YY' | 'M' | 'D')[];
}

const cache = new Map<string, CompiledPattern>();

export function compilePattern(pattern: string): CompiledPattern {
  const cached = cache.get(pattern);
  if (cached) return cached;

  const order: CompiledPattern['order'] = [];
  let source = '';
  let i = 0;
  while (i < pattern.length) {
    const rest = pattern.slice(i);
    if (rest.startsWith('YYYY')) {
      source += '(\\d{4})';
      order.push('Y');
      i += 4;
    } else if (rest.startsWith('YY')) {
      source += '(\\d{2})';
      order.push('YY');
      i += 2;
    } else if (rest.startsWith('MM') || rest.startsWith('DD')) {
      source += '(\\d{1,2})';
      order.push(rest[0] as 'M' | 'D');
      i += 2;
    } else if (rest[0] === 'M' || rest[0] === 'D') {
      source += '(\\d{1,2})';
      order.push(rest[0]);
      i += 1;
    } else {
      source += rest[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  // Tolère une partie horaire en suffixe (« 2024-03-01 14:30 », « …T14:30:00Z »), qui est ignorée.
  const compiled = { regex: new RegExp(`^\\s*${source}(?:[ T].*)?\\s*$`), order };
  cache.set(pattern, compiled);
  return compiled;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

export function formatDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
}

/** Date JavaScript (cellule Excel) vers AAAA-MM-JJ, en composantes locales comme SheetJS. */
export function dateObjectToIso(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  return formatDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Retourne AAAA-MM-JJ, ou null si la valeur ne respecte pas le format. */
export function normalizeDate(value: unknown, pattern: string): string | null {
  if (value == null) return null;
  if (value instanceof Date) return dateObjectToIso(value);

  const match = compilePattern(pattern).regex.exec(String(value));
  if (!match) return null;

  let y = NaN;
  let m = NaN;
  let d = NaN;
  compilePattern(pattern).order.forEach((token, idx) => {
    const n = Number(match[idx + 1]);
    if (token === 'Y') y = n;
    else if (token === 'YY') y = n < 50 ? 2000 + n : 1900 + n;
    else if (token === 'M') m = n;
    else d = n;
  });
  return isValidDate(y, m, d) ? formatDate(y, m, d) : null;
}

/**
 * Détecte le format de date d'un échantillon de chaînes.
 * Retourne le premier format qui convertit au moins 95 % des valeurs, et
 * signale l'ambiguïté jour/mois (ex. 03/04/2024) pour que l'IA ou
 * l'utilisateur tranche. Par défaut, l'usage québécois (jour avant mois) l'emporte.
 */
export function detectDatePattern(samples: string[]): { pattern: string; ambiguous: boolean } | null {
  if (samples.length === 0) return null;
  const candidates = KNOWN_PATTERNS.filter((p) => {
    const ok = samples.filter((s) => normalizeDate(s, p) !== null).length;
    return ok / samples.length >= 0.95;
  });
  if (candidates.length === 0) return null;
  const hasDayFirst = candidates.some((p) => p.startsWith('DD'));
  const hasMonthFirst = candidates.some((p) => p.startsWith('MM'));
  return { pattern: candidates[0]!, ambiguous: hasDayFirst && hasMonthFirst };
}
