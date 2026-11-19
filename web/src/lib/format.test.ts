import { describe, expect, it } from 'vitest';
import { fmt, kpiText } from './format';

describe('valeur d’un indicateur', () => {
  it('ajoute l’unité après une espace insécable, à la québécoise', () => {
    expect(kpiText(731.8, '$')).toBe('731,8 $');
    expect(kpiText(12.5, ' % ')).toBe('12,5 %');
    expect(kpiText(1250, 'kg')).toBe(`${fmt(1250)} kg`);
  });

  it('sans unité, ou sur une valeur vide, n’ajoute rien', () => {
    expect(kpiText(731.8, null)).toBe('731,8');
    expect(kpiText(731.8, '   ')).toBe('731,8');
    expect(kpiText(null, '$')).toBe('(vide)');
  });
});
