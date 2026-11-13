/**
 * Appariement approximatif de valeurs texte : retrouve, parmi les valeurs
 * réelles d'une colonne, celles qui ressemblent à la valeur demandée
 * (accents, casse, espaces, fautes de frappe, abréviations).
 * Fonctions pures, exécutées localement : aucune valeur ne quitte le navigateur.
 */

/** Minuscules, sans accents ni ponctuation, espaces réduits. « Côte-Nord » → « cote nord ». */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (!bHit[j] && a[i] === b[j]) {
        aHit[i] = bHit[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Similarité entre 0 et 1 sur les formes normalisées :
 * 1 = identiques à la casse et aux accents près ; 0,9 = l'une contient l'autre (mot entier) ;
 * sinon le meilleur de Jaro-Winkler et du ratio de Levenshtein.
 */
export function similarity(requested: string, candidate: string): number {
  const a = normalizeText(requested);
  const b = normalizeText(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 3 && ` ${longer} `.includes(` ${shorter} `)) return 0.9;
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return Math.min(0.89, Math.max(jaroWinkler(a, b), lev));
}

export interface CloseValue {
  value: string;
  score: number;
}

export function findCloseValues(
  requested: string,
  candidates: Iterable<string>,
  { threshold = 0.8, limit = 5 }: { threshold?: number; limit?: number } = {},
): CloseValue[] {
  const out: CloseValue[] = [];
  for (const value of candidates) {
    const score = similarity(requested, value);
    if (score >= threshold) out.push({ value, score });
  }
  return out.sort((x, y) => y.score - x.score || x.value.localeCompare(y.value, 'fr')).slice(0, limit);
}

/**
 * Correction sûre à appliquer sans demander : une seule valeur identique à la casse
 * et aux accents près, ou une seule valeur très proche nettement devant les autres.
 */
export function pickAutoCorrection(close: CloseValue[]): string | null {
  const [best, second] = close;
  if (!best) return null;
  if (best.score === 1) return second?.score === 1 ? null : best.value;
  if (best.score >= 0.9 && (!second || best.score - second.score >= 0.08)) return best.value;
  return null;
}

/** Littéral SQL entre apostrophes. */
export function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Remplace chaque occurrence du littéral `'from'` par `'to'` dans le SQL.
 * Retourne null si le littéral n'apparaît pas.
 */
export function replaceSqlLiteral(sql: string, from: string, to: string): string | null {
  const needle = sqlString(from);
  if (!sql.includes(needle)) return null;
  return sql.split(needle).join(sqlString(to));
}

/** Résultat « vide » : aucune ligne, ou une seule ligne dont toutes les valeurs sont nulles ou à zéro. */
export function looksEmpty(rows: Record<string, unknown>[]): boolean {
  if (rows.length === 0) return true;
  if (rows.length > 1) return false;
  return Object.values(rows[0]!).every((v) => v === null || v === 0);
}
