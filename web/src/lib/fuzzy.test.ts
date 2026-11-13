import { describe, expect, it } from 'vitest';
import { findCloseValues, looksEmpty, normalizeText, pickAutoCorrection, replaceSqlLiteral, similarity } from './fuzzy';

const regions = [
  'Montréal', 'Québec', 'Gaspésie', 'Outaouais', 'Estrie', 'Saguenay', 'Abitibi',
  'Côte-Nord', 'Laurentides', 'Lanaudière', 'Mauricie', 'Montérégie',
];

describe('appariement approximatif', () => {
  it('normalise accents, casse et ponctuation', () => {
    expect(normalizeText('  Côte-Nord ')).toBe('cote nord');
    expect(normalizeText('QUÉBEC')).toBe('quebec');
  });

  it('corrige automatiquement une différence d’accents ou de casse', () => {
    const close = findCloseValues('Montreal', regions);
    expect(close[0]).toEqual({ value: 'Montréal', score: 1 });
    expect(pickAutoCorrection(close)).toBe('Montréal');
    expect(pickAutoCorrection(findCloseValues('cote nord', regions))).toBe('Côte-Nord');
  });

  it('propose sans corriger une faute de frappe', () => {
    const close = findCloseValues('Gaspesy', regions);
    expect(close[0]?.value).toBe('Gaspésie');
    expect(close[0]!.score).toBeLessThan(1);
    expect(pickAutoCorrection(close)).toBeNull();
  });

  it('reconnaît une valeur contenue (mot entier)', () => {
    expect(similarity('Saguenay', 'Saguenay–Lac-Saint-Jean')).toBe(0.9);
    expect(pickAutoCorrection(findCloseValues('Saguenay', ['Saguenay–Lac-Saint-Jean', 'Estrie']))).toBe('Saguenay–Lac-Saint-Jean');
  });

  it('ne corrige pas quand deux valeurs sont équivalentes', () => {
    expect(pickAutoCorrection(findCloseValues('quebec', ['Québec', 'QUEBEC']))).toBeNull();
  });

  it('ne propose rien pour une valeur sans rapport', () => {
    expect(findCloseValues('Vancouver', regions)).toEqual([]);
  });

  it('remplace le littéral SQL en échappant les apostrophes', () => {
    const sql = `SELECT SUM("c3") FROM t WHERE "c1" = 'Cote d''Azur' OR "c1" IN ('Cote d''Azur')`;
    expect(replaceSqlLiteral(sql, "Cote d'Azur", "Côte d'Azur")).toBe(
      `SELECT SUM("c3") FROM t WHERE "c1" = 'Côte d''Azur' OR "c1" IN ('Côte d''Azur')`,
    );
    expect(replaceSqlLiteral(sql, 'Absent', 'X')).toBeNull();
  });

  it('détecte un résultat vide', () => {
    expect(looksEmpty([])).toBe(true);
    expect(looksEmpty([{ total: null }])).toBe(true);
    expect(looksEmpty([{ n: 0, total: null }])).toBe(true);
    expect(looksEmpty([{ total: 12 }])).toBe(false);
  });
});
