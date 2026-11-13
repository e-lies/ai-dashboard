/**
 * Rendu pur d'un QueryResult : tableau, tarte, colonnes, timeline ou KPI.
 * Les `nDims` premières colonnes du résultat sont des dimensions, les suivantes des mesures.
 */
import ReactECharts from 'echarts-for-react';
import type { CellValue, QueryResult, WidgetKind } from '../../../shared/types';
import { fmt } from '../lib/format';

interface Props {
  kind: WidgetKind;
  result: QueryResult;
  /** Nombre de colonnes de dimension en tête du résultat. Déduit si absent. */
  nDims?: number;
  height?: number;
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

export function ResultView({ kind, result, nDims, height = 280 }: Props) {
  const dims = nDims ?? inferDims(result);

  if (result.rows.length === 0) return <p className="muted">Aucun résultat.</p>;

  if (kind === 'kpi') {
    const m = result.columns[dims] ?? result.columns[0];
    return (
      <div className="kpi">
        <div className="kpi-value">{fmt(m ? (result.rows[0]?.[m.key] ?? null) : null)}</div>
        <div className="kpi-label">{m?.label}</div>
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
            {result.columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r, i) => (
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
