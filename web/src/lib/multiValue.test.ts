import { describe, expect, it } from 'vitest';
import type { ColumnSchema, DatasetMeta, Filter } from '../../../shared/types';
import { compileQuery } from './sql';
import { MAX_OPTIONS, addValues, matchOptions, resolveTyped, sortOptions, splitInput, toggleValue } from './multiValue';

const text: ColumnSchema = { id: 'c0', name: 'Région', type: 'string', role: 'dimension', sensitive: false, source: 'heuristic' };
const num: ColumnSchema = { ...text, id: 'c1', name: 'Montant', type: 'number', role: 'measure' };

describe('filtres « parmi » et « hors de »', () => {
  const meta: DatasetMeta = { id: 'abc', name: 'v', fileName: 'v.csv', rowCount: 1, createdAt: '', columns: [text, num] };
  const where = (f: Filter) => compileQuery({ datasetId: 'abc', filters: [f], groupBy: [], measures: [{ id: 'm0', fn: 'count' }] }, meta).sql;

  it('« hors de » conserve les vides, sauf si « (vide) » est exclu', () => {
    expect(where({ columnId: 'c0', op: 'notIn', values: ['Montréal'] })).toContain(`("c0" IS NULL OR "c0" NOT IN ('Montréal'))`);
    expect(where({ columnId: 'c0', op: 'notIn', values: ['Montréal', null] })).toContain(
      `("c0" IS NOT NULL AND "c0" NOT IN ('Montréal'))`,
    );
    expect(where({ columnId: 'c0', op: 'notIn', values: [null] })).toContain(`("c0" IS NOT NULL AND TRUE)`);
    expect(where({ columnId: 'c0', op: 'in', values: ['Montréal', null] })).toContain(`("c0" IN ('Montréal') OR "c0" IS NULL)`);
  });
});

describe('sélection multiple de valeurs', () => {
  it('découpe une saisie « a ; b », sans doublons ni vides, en typant selon la colonne', () => {
    expect(splitInput(' Montréal ; Québec;; Montréal ', text)).toEqual(['Montréal', 'Québec']);
    expect(splitInput('1 250,5 ; 640 ; abc', num)).toEqual([1250.5, 640]);
    expect(splitInput('(vide) ; Gaspé', text)).toEqual([null, 'Gaspé']);
  });

  it('coche, décoche et ajoute sans doublons, y compris la valeur vide', () => {
    let sel = toggleValue([], 'Montréal');
    sel = toggleValue(sel, null);
    expect(sel).toEqual(['Montréal', null]);
    expect(toggleValue(sel, 'Montréal')).toEqual([null]);
    expect(toggleValue(sel, null)).toEqual(['Montréal']);
    expect(addValues(sel, ['Québec', 'Montréal', 'Québec'])).toEqual(['Montréal', null, 'Québec']);
    // Une option numérique (texte « 640 ») correspond à la valeur choisie 640.
    expect(toggleValue([640], 640)).toEqual([]);
  });

  it('remplace une saisie par la valeur réelle qui ne diffère que par la casse ou les accents', () => {
    const opts = ['Gaspé', 'Lévis', 'Montréal'];
    expect(resolveTyped(['gaspe', 'Lévis', 'Laval', null, 640], opts)).toEqual(['Gaspé', 'Lévis', 'Laval', null, 640]);
  });

  it('trie les options à la française ou numériquement', () => {
    expect(sortOptions(['Québec', 'école', 'Abitibi', 'Montréal'], text)).toEqual(['Abitibi', 'école', 'Montréal', 'Québec']);
    expect(sortOptions(['100', '20', '3.5'], num)).toEqual(['3.5', '20', '100']);
  });

  it('filtre les options sans accents ni casse, avec « (vide) » en tête', () => {
    const opts = ['Montréal', 'Montréal-Nord', 'Québec'];
    expect(matchOptions(opts, '').items).toEqual([null, ...opts]);
    expect(matchOptions(opts, 'montreal').items).toEqual(['Montréal', 'Montréal-Nord']);
    expect(matchOptions(opts, 'vide').items).toEqual([null]);
    const many = Array.from({ length: MAX_OPTIONS + 50 }, (_, i) => `Valeur ${i}`);
    const r = matchOptions(many, 'valeur');
    expect(r.items).toHaveLength(MAX_OPTIONS);
    expect(r.more).toBe(50);
  });
});
