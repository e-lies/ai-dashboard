import { describe, expect, it } from 'vitest';
import type { DatasetMeta } from '../../../shared/types';
import { compileQuery } from './sql';
import { nextSort, sortRows } from './tableSort';

describe('tri des tableaux', () => {
  it('cycle croissant → décroissant → aucun, et repart en croissant sur une autre colonne', () => {
    const a = nextSort(null, 'x');
    expect(a).toEqual({ by: 'x', dir: 'asc' });
    const b = nextSort(a, 'x');
    expect(b).toEqual({ by: 'x', dir: 'desc' });
    expect(nextSort(b, 'x')).toBeNull();
    expect(nextSort(b, 'y')).toEqual({ by: 'y', dir: 'asc' });
  });

  it('trie nombres et textes à la française, vides toujours à la fin, de façon stable', () => {
    const rows = [
      { r: 'Québec', n: 10 },
      { r: null, n: 5 },
      { r: 'Abitibi', n: 10 },
      { r: 'Montréal', n: null },
      { r: 'école', n: 2 },
    ];
    expect(sortRows(rows, { by: 'r', dir: 'asc' }).map((x) => x.r)).toEqual(['Abitibi', 'école', 'Montréal', 'Québec', null]);
    expect(sortRows(rows, { by: 'r', dir: 'desc' }).map((x) => x.r)).toEqual(['Québec', 'Montréal', 'école', 'Abitibi', null]);
    // Égalité à 10 : l'ordre d'origine est conservé (Québec avant Abitibi).
    expect(sortRows(rows, { by: 'n', dir: 'desc' }).map((x) => x.r)).toEqual(['Québec', 'Abitibi', null, 'école', 'Montréal']);
    expect(sortRows(rows, null)).toBe(rows);
  });
});

const meta: DatasetMeta = {
  id: 'abc',
  name: 'ventes',
  fileName: 'v.csv',
  rowCount: 10,
  createdAt: '2026-11-18T00:00:00Z',
  columns: [
    { id: 'c0', name: 'Région', type: 'string', role: 'dimension', sensitive: false, source: 'heuristic' },
    { id: 'c1', name: 'Produit', type: 'string', role: 'dimension', sensitive: false, source: 'heuristic' },
    { id: 'c2', name: 'Canal', type: 'string', role: 'dimension', sensitive: false, source: 'heuristic' },
    { id: 'c3', name: 'Montant', type: 'number', role: 'measure', sensitive: false, source: 'heuristic' },
  ],
};

describe('tableau à plusieurs regroupements', () => {
  const spec = {
    datasetId: 'abc',
    filters: [],
    groupBy: [{ columnId: 'c0' }, { columnId: 'c1' }, { columnId: 'c2' }],
    measures: [{ id: 'm0', fn: 'sum' as const, columnId: 'c3' }],
  };

  it('regroupe sur trois colonnes et trie selon la colonne cliquée', () => {
    const q = compileQuery({ ...spec, sort: [{ by: 'g2', dir: 'asc' }] }, meta);
    expect(q.columns.map((c) => c.label)).toEqual(['Région', 'Produit', 'Canal', 'Somme – Montant']);
    expect(q.sql).toContain('GROUP BY 1, 2, 3');
    expect(q.sql).toContain('ORDER BY "g2" ASC NULLS LAST');
    expect(q.groupCountSql).toHaveLength(3);
  });

  it('ignore un tri devenu invalide et revient au tri par défaut', () => {
    const q = compileQuery({ ...spec, sort: [{ by: 'g5', dir: 'asc' }] }, meta);
    expect(q.sql).toContain('ORDER BY "m0" DESC NULLS LAST');
    const raw = compileQuery({ ...spec, groupBy: [], measures: [], columns: ['c0', 'c3'], sort: [{ by: 'm0', dir: 'asc' }] }, meta);
    expect(raw.sql).not.toContain('ORDER BY');
    const rawSorted = compileQuery({ ...spec, groupBy: [], measures: [], columns: ['c0', 'c3'], sort: [{ by: 'c3', dir: 'desc' }] }, meta);
    expect(rawSorted.sql).toContain('ORDER BY "c3" DESC NULLS LAST');
  });
});
