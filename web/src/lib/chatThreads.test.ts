import { describe, expect, it } from 'vitest';
import {
  cleanThreadName,
  defaultThreadName,
  isRefreshable,
  isStale,
  sortThreads,
  type ChatMessage,
  type ChatThread,
} from './chatThreads';

const msg = (role: ChatMessage['role'], text: string): ChatMessage => ({ id: text, role, text });

describe('discussions du chatbot', () => {
  it('propose la première question comme nom, abrégée au besoin', () => {
    expect(defaultThreadName([msg('assistant', 'Bonjour'), msg('user', '  Total   par région ? ')])).toBe('Total par région ?');
    const long = 'Quel est le montant total des ventes par région et par mois pour les années 2024 et 2025 ?';
    const name = defaultThreadName([msg('user', long)]);
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith('…')).toBe(true);
    expect(defaultThreadName([], new Date(2026, 10, 13))).toBe('Discussion du 2026-11-13');
  });

  it('nettoie le nom saisi et refuse un nom vide', () => {
    expect(cleanThreadName('  Ventes   Montréal ')).toBe('Ventes Montréal');
    expect(cleanThreadName('   ')).toBeNull();
    expect(cleanThreadName('x'.repeat(200))).toHaveLength(80);
  });

  it('repère les résultats calculés avant la mise à jour des données ou avec d’autres filtres', () => {
    const result = { columns: [], rows: [], truncated: false, sql: '' };
    const m = (extra: Partial<ChatMessage>): ChatMessage => ({ id: 'a', role: 'assistant', text: 't', sql: 'SELECT 1', result, ...extra });
    const ctx = { dataUpdatedAt: '2026-11-19T12:00:00Z', filters: ['Produit = « Coffret »'] };

    expect(isStale(m({ computedAt: '2026-11-19T13:00:00Z', computedFilters: ctx.filters }), ctx)).toBe(false);
    expect(isStale(m({ computedAt: '2026-11-19T11:00:00Z', computedFilters: ctx.filters }), ctx)).toBe(true);
    expect(isStale(m({ computedAt: '2026-11-19T13:00:00Z', computedFilters: [] }), ctx)).toBe(true);
    // Message antérieur au suivi : la date d'enregistrement de la discussion sert de repère.
    expect(isStale(m({}), { ...ctx, savedAt: '2026-11-18T00:00:00Z' })).toBe(true);
    expect(isStale(m({}), { ...ctx, savedAt: '2026-11-20T00:00:00Z' })).toBe(false);
    // Jamais mis à jour : seul un changement de filtres compte.
    expect(isStale(m({ computedAt: '2026-11-01T00:00:00Z', computedFilters: ctx.filters }), { filters: ctx.filters })).toBe(false);
    // Questions, refus et erreurs ne sont pas des résultats à actualiser.
    expect(isRefreshable({ id: 'q', role: 'user', text: 'q' })).toBe(false);
    expect(isRefreshable(m({ error: true }))).toBe(false);
    expect(isRefreshable(m({ sql: undefined }))).toBe(false);
  });

  it('trie les discussions de la plus récente à la plus ancienne', () => {
    const t = (id: string, updatedAt: string): ChatThread => ({ id, dashboardId: 'd', name: id, messages: [], createdAt: updatedAt, updatedAt });
    expect(sortThreads([t('a', '2026-11-01'), t('b', '2026-11-12'), t('c', '2026-11-05')]).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
});
