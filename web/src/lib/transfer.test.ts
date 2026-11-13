import { describe, expect, it } from 'vitest';
import type { DashboardSpec, DatasetMeta } from '../../../shared/types';
import {
  exportDashboard,
  exportFileName,
  importDashboard,
  parseDashboardFile,
  rewriteSqlIdentifiers,
  sensitiveFilterColumns,
} from './transfer';

const source: DatasetMeta = {
  id: 'src',
  name: 'ventes 2025',
  fileName: 'ventes.csv',
  rowCount: 10,
  createdAt: '2026-11-11T00:00:00Z',
  columns: [
    { id: 'c0', name: 'Région', type: 'string', role: 'dimension', sensitive: false, source: 'heuristic', stats: { count: 10, nullCount: 0, distinctCount: 2, topValues: [{ value: 'Montréal', count: 6 }] } },
    { id: 'c1', name: 'Montant', type: 'number', role: 'measure', sensitive: false, source: 'heuristic' },
    { id: 'c2', name: 'Courriel', type: 'string', role: 'identifier', sensitive: true, source: 'heuristic' },
    { id: 'c3', name: 'Inutilisée', type: 'string', role: 'text', sensitive: false, source: 'heuristic' },
  ],
};

// Même structure, colonnes dans un autre ordre (donc d'autres ids) et noms sans accents.
const target: DatasetMeta = {
  ...source,
  id: 'tgt',
  name: 'ventes 2026',
  columns: [
    { id: 'c0', name: 'Montant', type: 'integer', role: 'measure', sensitive: false, source: 'heuristic' },
    { id: 'c1', name: 'region', type: 'string', role: 'dimension', sensitive: false, source: 'heuristic' },
  ],
};

const dash: DashboardSpec = {
  id: 'd1',
  name: 'Ventes par région',
  datasetId: 'src',
  globalFilters: [{ columnId: 'c0', op: 'eq', value: 'Montréal' }],
  widgets: [
    {
      id: 'w1',
      title: 'Total par région',
      kind: 'bar',
      span: 2,
      query: {
        datasetId: 'src',
        filters: [{ columnId: 'c1', op: 'gte', value: 100 }],
        groupBy: [{ columnId: 'c0' }],
        measures: [{ id: 'm0', fn: 'sum', columnId: 'c1' }],
        sort: [{ by: 'm0', dir: 'desc' }],
        groupLimit: 10,
      },
    },
    {
      id: 'w2',
      title: 'Réponse épinglée',
      kind: 'table',
      sql: `SELECT "c0" AS "c1", SUM(c1) AS total FROM "dash_d1" WHERE "c0" <> 'c1' GROUP BY 1`,
      query: { datasetId: 'src', filters: [], groupBy: [], measures: [] },
    },
  ],
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
};

const roundTrip = (d: DashboardSpec, m: DatasetMeta) =>
  parseDashboardFile(JSON.stringify(exportDashboard(d, m, new Date('2026-11-13T00:00:00Z'))));

describe('export de dashboard', () => {
  it('ne contient que la structure des colonnes utilisées, sans statistiques ni lignes', () => {
    const file = exportDashboard(dash, source);
    expect(file.source.columns).toEqual([
      { id: 'c0', name: 'Région', type: 'string', role: 'dimension' },
      { id: 'c1', name: 'Montant', type: 'number', role: 'measure' },
    ]);
    expect(JSON.stringify(file)).not.toContain('topValues');
  });

  it('signale les filtres sur des colonnes sensibles', () => {
    expect(sensitiveFilterColumns(dash, source)).toEqual([]);
    const d = { ...dash, globalFilters: [{ columnId: 'c2', op: 'eq' as const, value: 'a@b.ca' }] };
    expect(sensitiveFilterColumns(d, source).map((c) => c.name)).toEqual(['Courriel']);
    const nullOnly = { ...dash, globalFilters: [{ columnId: 'c2', op: 'isNull' as const }] };
    expect(sensitiveFilterColumns(nullOnly, source)).toEqual([]);
  });

  it('produit un nom de fichier simple', () => {
    expect(exportFileName('Ventes par région / Québec')).toBe('ventes-par-region-quebec.tqdash.json');
  });
});

describe('import de dashboard', () => {
  it('réassocie les colonnes par nom et réécrit les ids, la table et la vue', () => {
    const d = importDashboard(roundTrip(dash, source), target, { newId: () => 'nouv', now: new Date('2026-11-13T00:00:00Z') });
    expect(d.id).toBe('nouv');
    expect(d.datasetId).toBe('tgt');
    expect(d.globalFilters).toEqual([{ columnId: 'c1', op: 'eq', value: 'Montréal' }]);
    const [w1, w2] = d.widgets;
    expect(w1!.query.datasetId).toBe('tgt');
    expect(w1!.query.filters).toEqual([{ columnId: 'c0', op: 'gte', value: 100 }]);
    expect(w1!.query.groupBy).toEqual([{ columnId: 'c1' }]);
    expect(w1!.query.measures).toEqual([{ id: 'm0', fn: 'sum', columnId: 'c0' }]);
    expect(w1!.query.sort).toEqual([{ by: 'm0', dir: 'desc' }]);
    expect(w1!.id).not.toBe('w1');
    // Échange c0 ↔ c1 en une passe ; la chaîne 'c1' et l'alias inconnu restent intacts.
    expect(w2!.sql).toBe(`SELECT "c1" AS "c0", SUM("c0") AS total FROM "dash_nouv" WHERE "c1" <> 'c1' GROUP BY 1`);
  });

  it('sur le même jeu, conserve les colonnes par id', () => {
    const d = importDashboard(roundTrip(dash, source), source, { newId: () => 'copie' });
    expect(d.globalFilters[0]!.columnId).toBe('c0');
    expect(d.widgets[1]!.sql).toContain('"dash_copie"');
  });

  it('refuse un jeu où des colonnes manquent ou ont un autre type', () => {
    const other: DatasetMeta = {
      ...target,
      name: 'autre',
      columns: [{ id: 'c0', name: 'Montant', type: 'string', role: 'dimension', sensitive: false, source: 'heuristic' }],
    };
    expect(() => importDashboard(roundTrip(dash, source), other)).toThrow(
      /« autre ».*colonnes introuvables : Région.*types incompatibles : Montant \(nombre attendu, texte trouvé\)/,
    );
  });

  it('rejette les fichiers invalides ou dangereux', () => {
    expect(() => parseDashboardFile('pas du json')).toThrow(/JSON valide/);
    expect(() => parseDashboardFile('{"format":"autre"}')).toThrow(/export de dashboard/);
    const file = exportDashboard(dash, source);
    expect(() => parseDashboardFile(JSON.stringify({ ...file, version: 99 }))).toThrow(/Version/);
    const bad = structuredClone(file);
    bad.dashboard.widgets[0]!.kind = 'carte' as never;
    expect(() => parseDashboardFile(JSON.stringify(bad))).toThrow(/incomplet/);
    const evil = structuredClone(file);
    evil.dashboard.widgets[1]!.sql = `SELECT * FROM read_csv('/etc/passwd')`;
    expect(() => importDashboard(parseDashboardFile(JSON.stringify(evil)), source)).toThrow();
  });
});

describe('réécriture SQL', () => {
  it('ignore commentaires et chaînes', () => {
    const out = rewriteSqlIdentifiers(`SELECT c0 -- c0\n, 'c0' FROM t /* c0 */`, (n) => (n === 'c0' ? 'c9' : undefined));
    expect(out).toBe(`SELECT "c9" -- c0\n, 'c0' FROM t /* c0 */`);
  });
});
