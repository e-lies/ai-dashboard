import { describe, expect, it } from 'vitest';
import type { DatasetMeta } from '../../../shared/types';
import { detectDatePattern, normalizeDate } from './dates';
import { maskValue, parseNumber, profileTable } from './profile';
import { compileQuery, validateReadOnlySql } from './sql';

describe('dates', () => {
  it('normalise selon le format détecté', () => {
    expect(normalizeDate('25/12/2024', 'DD/MM/YYYY')).toBe('2024-12-25');
    expect(normalizeDate('3/7/24', 'M/D/YY')).toBe('2024-03-07');
    expect(normalizeDate('2024-02-30', 'YYYY-MM-DD')).toBeNull();
    expect(normalizeDate('2024-03-01 14:30', 'YYYY-MM-DD')).toBe('2024-03-01');
  });
  it('signale l’ambiguïté jour/mois et privilégie le jour en premier', () => {
    expect(detectDatePattern(['01/02/2024', '03/04/2024'])).toEqual({ pattern: 'DD/MM/YYYY', ambiguous: true });
    expect(detectDatePattern(['12/25/2024', '01/31/2024'])).toEqual({ pattern: 'MM/DD/YYYY', ambiguous: false });
  });
});

describe('nombres', () => {
  it('gère les formats québécois et anglais', () => {
    expect(parseNumber('1 234,56 $')).toBe(1234.56);
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('12,5 %')).toBe(12.5);
    expect(parseNumber('1,234,567')).toBe(1234567);
    expect(parseNumber('00123')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
  });
});

describe('profilage', () => {
  it('détecte types, rôles et colonnes sensibles', () => {
    const cols = profileTable({
      headers: ['Région', 'Montant', 'Date', 'Courriel'],
      rows: [
        ['Est', '1 200,50', '01/02/2024', 'a@b.ca'],
        ['Ouest', '300', '15/02/2024', 'c@d.ca'],
        [null, '45,2', '20/03/2024', null],
      ],
    });
    expect(cols.map((c) => c.schema.type)).toEqual(['string', 'number', 'date', 'string']);
    expect(cols[1]!.schema.role).toBe('measure');
    expect(cols[2]!.schema.datePattern).toBe('DD/MM/YYYY');
    expect(cols[3]!.schema.sensitive).toBe(true);
    expect(cols[3]!.samples).toEqual([]);
  });
  it('masque les renseignements personnels dans les échantillons', () => {
    expect(maskValue('Joindre x.y@z.com au 514-555-1234, H2X 1Y4')).toBe('Joindre [courriel] au [téléphone], [code postal]');
  });
});

const meta: DatasetMeta = {
  id: 'abc',
  name: 't',
  fileName: 't.csv',
  rowCount: 0,
  createdAt: '',
  columns: [
    { id: 'c0', name: 'Région', type: 'string', role: 'dimension', sensitive: false, source: 'user' },
    { id: 'c1', name: 'Montant', type: 'number', role: 'measure', sensitive: false, source: 'user' },
    { id: 'c2', name: 'Date', type: 'date', role: 'temporal', sensitive: false, source: 'user' },
  ],
};

describe('compilation SQL', () => {
  it('limite les groupes catégoriels sans catégorie « Autres »', () => {
    const q = compileQuery(
      { datasetId: 'abc', filters: [{ columnId: 'c0', op: 'in', values: ['Est', null] }], groupBy: [{ columnId: 'c0' }], measures: [{ id: 'm0', fn: 'sum', columnId: 'c1' }], groupLimit: 10 },
      meta,
    );
    expect(q.sql).toContain('LIMIT 10');
    expect(q.sql).toContain('IS NOT DISTINCT FROM');
    expect(q.sql).toContain(`("c0" IN ('Est') OR "c0" IS NULL)`);
    expect(q.groupCountSql).toHaveLength(1);
  });
  it('ne tronque pas l’axe temporel', () => {
    const q = compileQuery(
      { datasetId: 'abc', filters: [], groupBy: [{ columnId: 'c2', timeGrain: 'month' }], measures: [{ id: 'm0', fn: 'count' }] },
      meta,
    );
    expect(q.sql).toContain(`date_trunc('month', "c2")`);
    expect(q.groupCountSql).toHaveLength(0);
  });
  it('échappe les valeurs', () => {
    const q = compileQuery(
      { datasetId: 'abc', filters: [{ columnId: 'c0', op: 'eq', value: "l'Est" }], groupBy: [], measures: [{ id: 'm0', fn: 'count' }] },
      meta,
    );
    expect(q.sql).toContain(`"c0" = 'l''Est'`);
  });
});

describe('validation du SQL du chatbot', () => {
  it('accepte un SELECT avec alias en français', () => {
    expect(() => validateReadOnlySql('SELECT "c0" AS "Mise à jour", COUNT(*) AS "Total" FROM ds_abc GROUP BY 1;')).not.toThrow();
  });
  it.each([
    'DROP TABLE ds_abc',
    'SELECT 1; DROP TABLE ds_abc',
    "SELECT * FROM read_csv('https://exemple.ca/x?d=1')",
    'SELECT * FROM "read_json"(\'x.json\')',
    "COPY ds_abc TO 'x.csv'",
  ])('refuse : %s', (sql) => {
    expect(() => validateReadOnlySql(sql)).toThrow();
  });
});
