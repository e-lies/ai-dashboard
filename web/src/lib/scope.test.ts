import { describe, expect, it } from 'vitest';
import type { DatasetMeta } from '../../../shared/types';
import { dashboardViewSql, describeFilter, validateReadOnlySql } from './sql';

const meta: DatasetMeta = {
  id: 'abc',
  name: 'ventes',
  fileName: 'ventes.csv',
  rowCount: 10,
  createdAt: '2026-11-11T00:00:00Z',
  columns: [
    { id: 'c0', name: 'Région', type: 'string', role: 'dimension', sensitive: false, source: 'heuristic' },
    { id: 'c1', name: 'Montant', type: 'number', role: 'measure', sensitive: false, source: 'heuristic' },
    { id: 'c2', name: 'Courriel', type: 'string', role: 'identifier', sensitive: true, source: 'heuristic' },
  ],
};

describe('vue filtrée du dashboard', () => {
  it('reprend les filtres complets du dashboard', () => {
    const sql = dashboardViewSql('d1', meta, [
      { columnId: 'c0', op: 'in', values: ['Montréal', null] },
      { columnId: 'c1', op: 'gte', value: 100 },
      { columnId: 'c1', op: 'lt' }, // incomplet : ignoré
    ]);
    expect(sql).toBe(
      `CREATE OR REPLACE VIEW "dash_d1" AS SELECT * FROM "ds_abc" WHERE ("c0" IN ('Montréal') OR "c0" IS NULL) AND "c1" >= 100`,
    );
  });

  it('sans filtre, la vue couvre tout le jeu', () => {
    expect(dashboardViewSql('d1', meta, [])).toBe(`CREATE OR REPLACE VIEW "dash_d1" AS SELECT * FROM "ds_abc"`);
  });

  it('le SQL du chatbot peut interroger la vue', () => {
    expect(() => validateReadOnlySql(`SELECT COUNT(*) FROM "dash_d1"`)).not.toThrow();
  });

  it('décrit les filtres et masque les valeurs sensibles pour le LLM', () => {
    expect(describeFilter({ columnId: 'c0', op: 'in', values: ['Montréal', null] }, meta)).toBe(
      'Région parmi « Montréal », (vide)',
    );
    expect(describeFilter({ columnId: 'c1', op: 'between', values: [10, 20] }, meta)).toBe(
      'Montant entre « 10 » et « 20 »',
    );
    const f = { columnId: 'c2', op: 'eq' as const, value: 'a@b.ca' };
    expect(describeFilter(f, meta)).toContain('a@b.ca');
    expect(describeFilter(f, meta, { hideSensitive: true })).toBe('Courriel = (valeur masquée)');
  });
});
