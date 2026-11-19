/**
 * Rendu pur d'un QueryResult : tableau, tarte, colonnes, timeline ou KPI.
 * Les `nDims` premières colonnes du résultat sont des dimensions, les suivantes des mesures.
 */
import ReactECharts from 'echarts-for-react';
import { useMemo, useState } from 'react';
import type { CellValue, QueryResult, SortSpec, WidgetKind } from '../../../shared/types';
import { fmt, kpiText } from '../lib/format';
import { nextSort, sortRows } from '../lib/tableSort';

interface Props {
  kind: WidgetKind;
  result: QueryResult;
  /** Nombre de colonnes de dimension en tête du résultat. Déduit si absent. */
  nDims?: number;
  height?: number;
  /**
   * Tri piloté par le parent (tableaux) : le parent relance la requête triée, sur toutes les données.
   * Sans `onSort`, le tri se fait ici, sur les lignes du résultat affiché.
   */
  sort?: SortSpec | null;
  onSort?(sort: SortSpec | null): void;
  /** Indicateur : sous-titre personnalisé, à la place du libellé de la mesure. */
  subtitle?: string | null;
  /** Indicateur : unité affichée après la valeur. */
  suffix?: string | null;
}

/** Pour un résultat SQL libre : les premières colonnes non numériques sont des dimensions. */
export function inferDims(result: QueryResult): number {
  const first = result.rows[0];
  if (!first) return 0;
  let n = 0;
  for (const c of result.columns) {
    const v = first[c.key];
    if (typeof v === 'number') break;
    n++;
    if (n === 2) break;
  }
  return Math.min(n, result.columns.length - 1);
}

function uniq(values: CellValue[]): CellValue[] {
  const seen = new Set<string>();
  const out: CellValue[] = [];
  for (const v of values) {
    const k = String(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

const tooltipFormatter = (v: unknown) => (typeof v === 'number' ? fmt(v) : String(v));

function buildOption(kind: WidgetKind, result: QueryResult, nDims: number) {
  const dims = result.columns.slice(0, nDims);
  const measures = result.columns.slice(nDims);
  const rows = result.rows;
  const d0 = dims[0];
  const m0 = measures[0];
  if (!d0 || !m0) return null;

  if (kind === 'pie') {
    return {
      tooltip: { trigger: 'item', valueFormatter: tooltipFormatter },
      legend: { type: 'scroll', bottom: 0 },
      series: [
        {
          type: 'pie',
          radius: ['35%', '65%'],
          data: rows.map((r) => ({ name: fmt(r[d0.key]), value: r[m0.key] })),
          label: { formatter: '{b} : {d} %' },
        },
      ],
    };
  }

  const seriesType = kind === 'timeline' ? 'line' : 'bar';
  const xValues = uniq(rows.map((r) => r[d0.key] ?? null));
  const xIndex = new Map(xValues.map((v, i) => [String(v), i]));
  const d1 = dims[1];

  let series;
  if (d1) {
    // Deux dimensions : la seconde devient la série, sur la première mesure.
    const seriesValues = uniq(rows.map((r) => r[d1.key] ?? null));
    series = seriesValues.map((sv) => {
      const data: (number | null)[] = new Array(xValues.length).fill(null);
      rows
        .filter((r) => String(r[d1.key]) === String(sv))
        .forEach((r) => {
          data[xIndex.get(String(r[d0.key]))!] = (r[m0.key] as number) ?? null;
        });
      return {
        name: fmt(sv),
        type: seriesType,
        data,
        stack: kind === 'bar' ? 'total' : undefined,
        connectNulls: kind === 'timeline',
      };
    });
  } else {
    series = measures.map((m) => ({
      name: m.label,
      type: seriesType,
      data: rows.map((r) => r[m.key]),
      smooth: kind === 'timeline',
    }));
  }

  return {
    tooltip: { trigger: 'axis', valueFormatter: tooltipFormatter },
    legend: { type: 'scroll', bottom: 0 },
    grid: { left: 8, right: 16, top: 16, bottom: 40, containLabel: true },
    xAxis: { type: 'category', data: xValues.map(fmt), axisLabel: { hideOverlap: true } },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmt(v) } },
    dataZoom: kind === 'timeline' && xValues.length > 30 ? [{ type: 'inside' }, { type: 'slider', bottom: 20 }] : undefined,
    series,
  };
}

export function ResultView({ kind, result, nDims, height = 280, sort: controlledSort, onSort, subtitle, suffix }: Props) {
  const dims = nDims ?? inferDims(result);
  const [localSort, setLocalSort] = useState<SortSpec | null>(null);
  const sort = onSort ? (controlledSort ?? null) : localSort;
  // En mode piloté, les lignes arrivent déjà triées par la requête.
  const rows = useMemo(() => (onSort ? result.rows : sortRows(result.rows, localSort)), [onSort, result.rows, localSort]);
  const toggleSort = (key: string) => {
    const next = nextSort(sort, key);
    if (onSort) onSort(next);
    else setLocalSort(next);
  };

  if (result.rows.length === 0) return <p className="muted">Aucun résultat.</p>;

  if (kind === 'kpi') {
    const m = result.columns[dims] ?? result.columns[0];
    return (
      <div className="kpi">
        <div className="kpi-value">{kpiText(m ? (result.rows[0]?.[m.key] ?? null) : null, suffix)}</div>
        <div className="kpi-label">{subtitle?.trim() || m?.label}</div>
      </div>
    );
  }

  if (kind !== 'table') {
    const option = buildOption(kind, result, Math.max(dims, 1));
    if (option) return <ReactECharts option={option} style={{ height, width: '100%' }} notMerge />;
  }

  return (
    <div className="table-wrap" style={{ maxHeight: height + 120 }}>
      <table className="data">
        <thead>
          <tr>
            {result.columns.map((c) => {
              const active = sort?.by === c.key;
              const numeric = result.rows.some((r) => typeof r[c.key] === 'number');
              return (
                <th
                  key={c.key}
                  className={`sortable${numeric ? ' num' : ''}`}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button className="th-sort" onClick={() => toggleSort(c.key)} title="Trier par cette colonne">
                    {c.label}
                    <span className="sort-mark">{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {result.columns.map((c) => {
                const v = r[c.key] ?? null;
                return (
                  <td key={c.key} className={typeof v === 'number' ? 'num' : v === null ? 'null' : undefined}>
                    {fmt(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
