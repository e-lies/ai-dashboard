import { describe, expect, it } from 'vitest';
import { cleanThreadName, defaultThreadName, sortThreads, type ChatMessage, type ChatThread } from './chatThreads';

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

  it('trie les discussions de la plus récente à la plus ancienne', () => {
    const t = (id: string, updatedAt: string): ChatThread => ({ id, dashboardId: 'd', name: id, messages: [], createdAt: updatedAt, updatedAt });
    expect(sortThreads([t('a', '2026-11-01'), t('b', '2026-11-12'), t('c', '2026-11-05')]).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
});
