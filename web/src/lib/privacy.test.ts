/**
 * Ce qui part vers l'IA : uniquement le schéma, la question et ce que le LLM a lui-même produit.
 * Aucune valeur des données (lignes, statistiques, résultats, valeurs de filtres) ne doit y figurer.
 */
import { describe, expect, it } from 'vitest';
import { ChatPlanRequest, ChatPlanResponse } from '../../../shared/contracts';
import type { DatasetMeta } from '../../../shared/types';
import { historyFor, redactDbError, schemaContext, type ChatMessage } from './chatThreads';
import { describeFilter } from './sql';

const meta: DatasetMeta = {
  id: 'abc',
  name: 'ventes',
  fileName: 'ventes.csv',
  rowCount: 3,
  createdAt: '2026-11-17T00:00:00Z',
  columns: [
    {
      id: 'c0',
      name: 'Région',
      type: 'string',
      role: 'dimension',
      sensitive: false,
      source: 'heuristic',
      description: '  Région administrative du client ',
      stats: { count: 3, nullCount: 0, distinctCount: 2, min: 'Montréal', max: 'Québec', topValues: [{ value: 'Montréal', count: 2 }] },
    },
    {
      id: 'c1',
      name: 'Courriel',
      type: 'string',
      role: 'identifier',
      sensitive: true,
      source: 'heuristic',
      stats: { count: 3, nullCount: 0, distinctCount: 3, min: 'a@b.ca', max: 'z@y.ca', topValues: [] },
    },
  ],
};

describe('données envoyées à l’IA', () => {
  it('le schéma ne contient ni statistiques ni valeurs', () => {
    const cols = schemaContext(meta);
    expect(cols).toEqual([
      { id: 'c0', name: 'Région', type: 'string', role: 'dimension', description: 'Région administrative du client' },
      { id: 'c1', name: 'Courriel', type: 'string', role: 'identifier', description: null },
    ]);
    const json = JSON.stringify(cols);
    for (const v of ['Montréal', 'Québec', 'a@b.ca', 'topValues', 'nullCount']) expect(json).not.toContain(v);
  });

  it('le serveur refuse une requête qui contiendrait des statistiques ou des valeurs', () => {
    const base = { question: 'Total par région ?', table: 'ds_abc', columns: schemaContext(meta) };
    expect(ChatPlanRequest.safeParse(base).success).toBe(true);
    const withStats = { ...base, columns: [{ ...base.columns[0], topValues: ['Montréal'] }] };
    expect(ChatPlanRequest.safeParse(withStats).success).toBe(false);
    expect(ChatPlanRequest.safeParse({ ...base, result: [{ total: 1 }] }).success).toBe(false);
    expect(ChatPlanRequest.safeParse({ ...base, rowCount: 3 }).success).toBe(false);
  });

  it('les filtres du dashboard sont décrits sans leurs valeurs', () => {
    expect(describeFilter({ columnId: 'c0', op: 'in', values: ['Montréal'] }, meta, { hideValues: true })).toBe(
      'Région parmi (valeurs non communiquées)',
    );
    expect(describeFilter({ columnId: 'c0', op: 'between', values: ['A', 'M'] }, meta, { hideValues: true })).toBe(
      'Région entre deux bornes (valeurs non communiquées)',
    );
    expect(describeFilter({ columnId: 'c1', op: 'isNull' }, meta, { hideValues: true })).toBe('Courriel est vide');
  });

  it('l’historique ne renvoie que les questions et ce que le LLM a produit', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', text: 'Total pour Montreal ?' },
      {
        id: '2',
        role: 'assistant',
        text: 'Voici le total.',
        explanation: 'Voici le total.',
        modelSql: `SELECT SUM("c2") FROM t WHERE "c0" = 'Montreal'`,
        // SQL corrigé localement avec la valeur réelle, et résultat : jamais renvoyés.
        sql: `SELECT SUM("c2") FROM t WHERE "c0" = 'Montréal'`,
        result: { columns: [{ key: 't', label: 't' }], rows: [{ t: 1250.5 }], truncated: false, sql: '' },
        notes: ['« Montreal » a été interprété comme « Montréal » (Région).'],
      },
      { id: '3', role: 'user', text: 'Région : « Québec »', local: true },
      { id: '4', role: 'assistant', text: 'Je n’ai pas réussi (Could not convert string \'Gaspé\').', error: true },
      // Ancienne réponse rédigée à partir des résultats : jamais renvoyée.
      { id: '5', role: 'assistant', text: 'Le total à Montréal est de 1 250,50 $.', sql: 'SELECT 1' },
    ];
    const history = historyFor(messages);
    expect(history).toEqual([
      { role: 'user', content: 'Total pour Montreal ?' },
      { role: 'assistant', content: `Voici le total.\n(SQL : SELECT SUM("c2") FROM t WHERE "c0" = 'Montreal')` },
    ]);
    const json = JSON.stringify(history);
    for (const v of ['Montréal', 'Québec', 'Gaspé', '1250', '1 250']) expect(json).not.toContain(v);
  });

  it('un refus de Claude fait partie de l’historique, pour que la question suivante garde le contexte', () => {
    expect(
      ChatPlanResponse.safeParse({
        kind: 'unanswerable',
        sql: null,
        chart: 'table',
        message: 'Les données ne contiennent aucun coût : la marge ne peut pas être calculée.',
        alternative: 'Quel est le montant total des ventes par produit ?',
        literals: [],
      }).success,
    ).toBe(true);
    const history = historyFor([
      { id: '1', role: 'user', text: 'Quelle est la marge par produit ?' },
      {
        id: '2',
        role: 'assistant',
        text: 'Les données ne contiennent aucun coût.',
        explanation: 'Les données ne contiennent aucun coût.',
        unanswerable: true,
        alternative: 'Quel est le montant total des ventes par produit ?',
      },
    ]);
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'Les données ne contiennent aucun coût.' });
  });

  it('les erreurs DuckDB sont expurgées des valeurs citées', () => {
    expect(redactDbError(`Conversion Error: Could not convert string 'Gaspé' to INT32 at "c1"`)).toBe(
      `Conversion Error: Could not convert string '…' to INT32 at "c1"`,
    );
  });
});
