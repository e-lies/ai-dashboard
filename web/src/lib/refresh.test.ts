import { describe, expect, it } from 'vitest';
import type { DatasetMeta } from '../../../shared/types';
import type { RawWorkbook } from './ingest';
import { matchColumns, prepareRefresh } from './refresh';

const meta: DatasetMeta = {
  id: 'abc',
  name: 'ventes',
  fileName: 'ventes-2025.csv',
  rowCount: 2,
  createdAt: '2026-11-01T00:00:00Z',
  columns: [
    { id: 'c0', name: 'Région', type: 'string', role: 'dimension', sensitive: false, source: 'heuristic', description: 'Région de la vente' },
    { id: 'c1', name: 'Montant', type: 'number', role: 'measure', sensitive: false, source: 'heuristic' },
    { id: 'c2', name: 'Date', type: 'date', role: 'temporal', datePattern: 'DD/MM/YYYY', sensitive: false, source: 'heuristic' },
  ],
};

const book = (matrix: unknown[][], name = 'Feuil1'): RawWorkbook => ({
  fileName: 'ventes-2026.xlsx',
  sheets: [{ name, matrix: matrix as RawWorkbook['sheets'][0]['matrix'] }],
});

describe('correspondance des colonnes', () => {
  it('retrouve les colonnes dans un autre ordre, aux accents et à la casse près, et liste les colonnes en trop', () => {
    const m = matchColumns(['date', 'Commentaire', 'MONTANT', 'Region'], meta.columns);
    expect(m.indexes).toEqual([3, 2, 0]);
    expect(m.missing).toEqual([]);
    expect(m.extra).toEqual(['Commentaire']);
  });

  it('préfère le nom exact au nom approchant', () => {
    expect(matchColumns(['region', 'Région', 'Montant', 'Date'], meta.columns).indexes).toEqual([1, 2, 3]);
  });
});

describe('mise à jour des données', () => {
  it('refuse un fichier auquel il manque des colonnes du schéma', () => {
    const plan = prepareRefresh(meta, book([['Région', 'Total'], ['Montréal', 10]]));
    expect(plan).toEqual({ ok: false, missing: ['Montant', 'Date'], sheetName: undefined });
  });

  it('remplace les lignes en gardant le schéma, même avec un titre au-dessus des en-têtes', () => {
    const plan = prepareRefresh(
      meta,
      book([
        ['Rapport des ventes 2026'],
        [],
        ['Date', 'Montant', 'Région', 'Note'],
        ['05/01/2026', '1 250,50', 'Montréal', 'x'],
        ['06/01/2026', 'n/d', 'Québec', 'y'],
        ['07/01/2026', '45', 'Gaspé', null],
      ]),
      new Date('2026-11-19T12:00:00Z'),
    );
    if (!plan.ok) throw new Error('refusé');
    expect(plan.rows).toEqual([
      ['Montréal', 1250.5, '2026-01-05'],
      ['Québec', null, '2026-01-06'],
      ['Gaspé', 45, '2026-01-07'],
    ]);
    expect(plan.rejected).toEqual([{ column: 'Montant', count: 1 }]);
    expect(plan.extra).toEqual(['Note']);
    // Schéma inchangé (ids, types, descriptions) ; statistiques, compte et fichier mis à jour.
    expect(plan.meta.id).toBe('abc');
    expect(plan.meta.columns.map((c) => [c.id, c.type, c.description])).toEqual([
      ['c0', 'string', 'Région de la vente'],
      ['c1', 'number', undefined],
      ['c2', 'date', undefined],
    ]);
    expect(plan.meta.rowCount).toBe(3);
    expect(plan.meta.fileName).toBe('ventes-2026.xlsx');
    expect(plan.meta.createdAt).toBe('2026-11-01T00:00:00Z');
    expect(plan.meta.updatedAt).toBe('2026-11-19T12:00:00.000Z');
    expect(plan.meta.columns[1]!.stats?.max).toBe(1250.5);
  });

  it('cherche l’onglet qui contient toutes les colonnes', () => {
    const wb: RawWorkbook = {
      fileName: 'classeur.xlsx',
      sheets: [
        { name: 'Notes', matrix: [['Texte'], ['bonjour']] },
        { name: 'Ventes', matrix: [['Région', 'Montant', 'Date'], ['Lévis', 10, '01/02/2026']] },
      ],
    };
    const plan = prepareRefresh(meta, wb);
    expect(plan.ok && plan.meta.sheetName).toBe('Ventes');
  });
});
