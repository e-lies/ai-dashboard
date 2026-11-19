/**
 * Construction d'un widget : choix du type, des colonnes par rôle, des mesures
 * et des filtres, avec aperçu en direct.
 */
import { nanoid } from 'nanoid';
import { useState } from 'react';
import type { AggFn, ColumnSchema, DatasetMeta, Filter, GroupBy, Measure, TimeGrain, WidgetKind, WidgetSpec } from '../../../shared/types';
import { DEFAULT_GROUP_LIMIT, measureLabel } from '../lib/sql';
import { FilterEditor } from './FilterEditor';
import { WidgetView } from './WidgetView';

const KINDS: { value: WidgetKind; label: string }[] = [
  { value: 'bar', label: 'Colonnes' },
  { value: 'pie', label: 'Tarte' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'table', label: 'Tableau' },
  { value: 'kpi', label: 'Indicateur' },
];

const FNS: { value: AggFn; label: string; needs: 'none' | 'any' | 'numeric' | 'ordered' }[] = [
  { value: 'count', label: 'Nombre de lignes', needs: 'none' },
  { value: 'countValues', label: 'Nombre de valeurs', needs: 'any' },
  { value: 'countNull', label: 'Nombre de vides', needs: 'any' },
  { value: 'countDistinct', label: 'Valeurs distinctes', needs: 'any' },
  { value: 'sum', label: 'Somme', needs: 'numeric' },
  { value: 'avg', label: 'Moyenne', needs: 'numeric' },
  { value: 'min', label: 'Minimum', needs: 'ordered' },
  { value: 'max', label: 'Maximum', needs: 'ordered' },
];

const GRAINS: { value: TimeGrain; label: string }[] = [
  { value: 'day', label: 'Jour' },
  { value: 'week', label: 'Semaine' },
  { value: 'month', label: 'Mois' },
  { value: 'quarter', label: 'Trimestre' },
  { value: 'year', label: 'Année' },
];

const isNumeric = (c: ColumnSchema) => c.type === 'number' || c.type === 'integer';

/** Nombre maximal de regroupements : un tableau en accepte plusieurs, un graphique au plus deux (axe et série). */
export const MAX_TABLE_GROUPS = 6;
export function maxGroups(kind: WidgetKind): number {
  if (kind === 'kpi') return 0;
  if (kind === 'pie') return 1;
  if (kind === 'table') return MAX_TABLE_GROUPS;
  return 2;
}

function columnsForFn(cols: ColumnSchema[], fn: AggFn): ColumnSchema[] {
  const needs = FNS.find((f) => f.value === fn)?.needs;
  // On ne propose jamais de sommer ou moyenner un identifiant.
  if (needs === 'numeric') return cols.filter((c) => isNumeric(c) && c.role === 'measure');
  if (needs === 'ordered') return cols.filter((c) => isNumeric(c) || c.type === 'date');
  return cols;
}

/** Ajuste la spec quand on change de type, pour qu'elle reste cohérente. */
function normalizeForKind(w: WidgetSpec, meta: DatasetMeta): WidgetSpec {
  const q = { ...w.query };
  const dims = meta.columns.filter((c) => c.role === 'dimension');
  const dates = meta.columns.filter((c) => c.type === 'date');
  const firstMeasure: Measure = q.measures[0] ?? { id: 'm0', fn: 'count' };

  switch (w.kind) {
    case 'kpi':
      q.groupBy = [];
      q.measures = [firstMeasure];
      break;
    case 'pie':
      q.groupBy = q.groupBy.slice(0, 1);
      if (!q.groupBy.length && dims[0]) q.groupBy = [{ columnId: dims[0].id }];
      q.measures = [firstMeasure];
      break;
    case 'timeline': {
      const hasDate = q.groupBy[0] && dates.some((d) => d.id === q.groupBy[0]!.columnId);
      if (!hasDate && dates[0]) q.groupBy = [{ columnId: dates[0].id, timeGrain: 'month' }];
      q.groupBy = q.groupBy.slice(0, 2);
      if (!q.measures.length) q.measures = [firstMeasure];
      break;
    }
    case 'bar':
      q.groupBy = q.groupBy.slice(0, 2);
      if (!q.groupBy.length && dims[0]) q.groupBy = [{ columnId: dims[0].id }];
      if (!q.measures.length) q.measures = [firstMeasure];
      break;
    case 'table':
      break;
  }
  return { ...w, query: q };
}

export function newWidget(meta: DatasetMeta, kind: WidgetKind = 'bar'): WidgetSpec {
  return normalizeForKind(
    {
      id: nanoid(8),
      title: 'Nouveau widget',
      kind,
      span: 2,
      query: { datasetId: meta.id, filters: [], groupBy: [], measures: [{ id: 'm0', fn: 'count' }], groupLimit: DEFAULT_GROUP_LIMIT },
    },
    meta,
  );
}

interface Props {
  meta: DatasetMeta;
  initial: WidgetSpec;
  globalFilters: Filter[];
  onSave(w: WidgetSpec): void;
  onCancel(): void;
}

export function WidgetBuilder({ meta, initial, globalFilters, onSave, onCancel }: Props) {
  const [w, setW] = useState<WidgetSpec>(initial);
  const q = w.query;
  const setQuery = (patch: Partial<WidgetSpec['query']>) => setW({ ...w, query: { ...q, ...patch } });

  const rawMode = w.kind === 'table' && q.groupBy.length === 0 && q.measures.length === 0;
  const maxDims = maxGroups(w.kind);
  const singleMeasure = w.kind === 'pie' || w.kind === 'kpi';
  // Une colonne déjà utilisée par un autre regroupement n'est pas reproposée.
  const dimCandidates = (index: number) =>
    meta.columns.filter(
      (c) =>
        (w.kind === 'timeline' && index === 0 ? c.type === 'date' : c.role !== 'text' && c.role !== 'measure') &&
        !q.groupBy.some((g, j) => j !== index && g.columnId === c.id),
    );

  const setGroup = (i: number, g: GroupBy | null) => {
    const next = [...q.groupBy];
    if (g) next[i] = g;
    else next.splice(i, 1);
    setQuery({ groupBy: next });
  };

  const setMeasure = (i: number, m: Measure) => setQuery({ measures: q.measures.map((x, j) => (j === i ? m : x)) });

  return (
    <div className="builder">
      <div className="builder-form">
        <label>
          Titre
          <input value={w.title} onChange={(e) => setW({ ...w, title: e.target.value })} />
        </label>

        <label>
          Type
          <select value={w.kind} onChange={(e) => setW(normalizeForKind({ ...w, kind: e.target.value as WidgetKind }, meta))}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Largeur
          <select value={w.span ?? 2} onChange={(e) => setW({ ...w, span: Number(e.target.value) as 1 | 2 | 3 | 4 })}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n} / 4
              </option>
            ))}
          </select>
        </label>

        {w.kind === 'kpi' && (
          <label>
            Sous-titre
            <input
              value={w.subtitle ?? ''}
              maxLength={120}
              placeholder={q.measures[0] ? measureLabel(q.measures[0], meta) : 'Libellé de la mesure'}
              onChange={(e) => setW({ ...w, subtitle: e.target.value || null })}
            />
            <span className="hint">Texte affiché sous la valeur. Laissez vide pour le libellé de la mesure.</span>
          </label>
        )}

        {w.kind === 'kpi' && (
          <label>
            Suffixe
            <input
              list="kpi-suffixes"
              value={w.suffix ?? ''}
              maxLength={20}
              placeholder="ex. $, %, kg"
              onChange={(e) => setW({ ...w, suffix: e.target.value || null })}
            />
            <datalist id="kpi-suffixes">
              {['$', '%', 'k$', 'M$', 'kg', 't', 'h', 'min', 'km', 'L'].map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <span className="hint">Unité affichée après la valeur (ex. « 731,8 $ »). Vide : aucune unité.</span>
          </label>
        )}

        {w.kind === 'table' && (
          <label className="inline">
            <input
              type="checkbox"
              checked={rawMode}
              onChange={(e) =>
                setQuery(
                  e.target.checked
                    ? { groupBy: [], measures: [], columns: meta.columns.map((c) => c.id), rowLimit: 500 }
                    : { measures: [{ id: 'm0', fn: 'count' }] },
                )
              }
            />
            Lignes brutes (sans regroupement)
          </label>
        )}

        {rawMode ? (
          <fieldset>
            <legend>Colonnes affichées</legend>
            {meta.columns.map((c) => (
              <label className="inline" key={c.id}>
                <input
                  type="checkbox"
                  checked={q.columns?.includes(c.id) ?? false}
                  onChange={(e) =>
                    setQuery({
                      columns: e.target.checked
                        ? meta.columns.filter((x) => x.id === c.id || q.columns?.includes(x.id)).map((x) => x.id)
                        : (q.columns ?? []).filter((id) => id !== c.id),
                    })
                  }
                />
                {c.name}
              </label>
            ))}
          </fieldset>
        ) : (
          <>
            {maxDims > 0 && (
              <fieldset>
                <legend>Regroupement</legend>
                {Array.from({ length: Math.min(maxDims, q.groupBy.length + 1) }, (_, i) => {
                  const g = q.groupBy[i];
                  const col = g && meta.columns.find((c) => c.id === g.columnId);
                  return (
                    <div className="row" key={i}>
                      <select
                        value={g?.columnId ?? ''}
                        onChange={(e) => {
                          const c = meta.columns.find((x) => x.id === e.target.value);
                          setGroup(i, c ? { columnId: c.id, timeGrain: c.type === 'date' ? 'month' : undefined } : null);
                        }}
                      >
                        <option value="">
                          {i === 0 ? '— choisir —' : w.kind === 'table' ? '— aucun —' : '— aucune série —'}
                        </option>
                        {dimCandidates(i).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      {col?.type === 'date' && g && (
                        <select
                          value={g.timeGrain ?? 'day'}
                          onChange={(e) => setGroup(i, { ...g, timeGrain: e.target.value as TimeGrain })}
                        >
                          {GRAINS.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  );
                })}
                {w.kind === 'table' && (
                  <p className="hint">
                    Jusqu’à {MAX_TABLE_GROUPS} regroupements. Chaque colonne catégorielle est limitée à ses groupes
                    principaux, selon le nombre maximal ci-dessous.
                  </p>
                )}
                <label>
                  Nombre maximal de groupes
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={q.groupLimit ?? DEFAULT_GROUP_LIMIT}
                    onChange={(e) => setQuery({ groupLimit: Math.max(1, Number(e.target.value) || DEFAULT_GROUP_LIMIT) })}
                  />
                </label>
              </fieldset>
            )}

            <fieldset>
              <legend>Mesures</legend>
              {q.measures.map((m, i) => {
                const candidates = columnsForFn(meta.columns, m.fn);
                return (
                  <div className="row" key={m.id}>
                    <select
                      value={m.fn}
                      onChange={(e) => {
                        const fn = e.target.value as AggFn;
                        const cols = columnsForFn(meta.columns, fn);
                        const keep = cols.some((c) => c.id === m.columnId);
                        setMeasure(i, { ...m, fn, columnId: fn === 'count' ? undefined : keep ? m.columnId : cols[0]?.id });
                      }}
                    >
                      {FNS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    {m.fn !== 'count' && (
                      <select value={m.columnId ?? ''} onChange={(e) => setMeasure(i, { ...m, columnId: e.target.value })}>
                        {candidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {!singleMeasure && q.measures.length > 1 && (
                      <button className="icon" onClick={() => setQuery({ measures: q.measures.filter((_, j) => j !== i) })}>
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
              {!singleMeasure && (
                <button className="link" onClick={() => setQuery({ measures: [...q.measures, { id: `m${nanoid(4)}`, fn: 'count' }] })}>
                  + Ajouter une mesure
                </button>
              )}
              <p className="hint">« Nombre de lignes » inclut les lignes vides ; somme, moyenne, min et max ignorent les vides.</p>
            </fieldset>
          </>
        )}

        <fieldset>
          <legend>Filtres du widget</legend>
          <FilterEditor meta={meta} filters={q.filters} onChange={(filters) => setQuery({ filters })} />
        </fieldset>

        <div className="actions">
          <button onClick={onCancel}>Annuler</button>
          <button className="primary" onClick={() => onSave(w)}>
            Enregistrer
          </button>
        </div>
      </div>

      <div className="builder-preview">
        <h3>{w.title}</h3>
        {w.kind === 'table' && (
          <p className="hint">Cliquez sur un en-tête de colonne pour définir le tri par défaut du tableau.</p>
        )}
        <WidgetView
          widget={w}
          meta={meta}
          globalFilters={globalFilters}
          showSql
          height={320}
          onSortChange={(s) => setQuery({ sort: s ? [s] : undefined })}
        />
      </div>
    </div>
  );
}
