/**
 * Tableau de tout le jeu de données, paginé et trié par DuckDB :
 * seule la page affichée est lue, quel que soit le nombre de lignes.
 * À monter avec key={meta.id} pour repartir de la première page à chaque jeu de données.
 */
import { useEffect, useState } from 'react';
import type { CellValue, DatasetMeta } from '../../../shared/types';
import { runSql } from '../lib/db';
import { fmt, fmtInt } from '../lib/format';
import { ident, tableName } from '../lib/sql';
import { useApp } from '../store';

const PAGE_SIZES = [25, 50, 100, 250];

type Sort = { columnId: string; dir: 'asc' | 'desc' } | null;

export function DataTable({ meta }: { meta: DatasetMeta }) {
  const ensureLoaded = useApp((s) => s.ensureLoaded);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<Sort>(null);
  const [rows, setRows] = useState<Record<string, CellValue>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pageCount = Math.max(1, Math.ceil(meta.rowCount / pageSize));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        await ensureLoaded(meta.id);
        // Tri stable : la colonne choisie, nulls à la fin, puis l'ordre d'origine du fichier.
        const order = sort ? `${ident(sort.columnId)} ${sort.dir.toUpperCase()} NULLS LAST, rowid` : 'rowid';
        const cols = meta.columns.map((c) => ident(c.id)).join(', ');
        const result = await runSql(
          `SELECT ${cols} FROM ${ident(tableName(meta.id))} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${page * pageSize}`,
        );
        if (!cancelled) {
          setRows(result);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meta, page, pageSize, sort, ensureLoaded]);

  function toggleSort(columnId: string) {
    setPage(0);
    setSort((s) => {
      if (s?.columnId !== columnId) return { columnId, dir: 'asc' };
      if (s.dir === 'asc') return { columnId, dir: 'desc' };
      return null;
    });
  }

  const first = meta.rowCount === 0 ? 0 : page * pageSize + 1;
  const last = Math.min(meta.rowCount, (page + 1) * pageSize);

  return (
    <div className="data-table">
      {error && <p className="error">{error}</p>}
      <div className={`table-wrap${loading ? ' loading' : ''}`} style={{ maxHeight: 560 }}>
        <table className="data">
          <thead>
            <tr>
              {meta.columns.map((c) => {
                const active = sort?.columnId === c.id;
                return (
                  <th
                    key={c.id}
                    className={`sortable${c.type === 'number' || c.type === 'integer' ? ' num' : ''}`}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button className="th-sort" onClick={() => toggleSort(c.id)} title="Trier">
                      {c.name}
                      <span className="sort-mark">{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={page * pageSize + i}>
                {meta.columns.map((c) => {
                  const v = r[c.id] ?? null;
                  return (
                    <td key={c.id} className={typeof v === 'number' ? 'num' : v === null ? 'null' : undefined}>
                      {fmt(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span className="muted small">
          Lignes {fmtInt(first)} à {fmtInt(last)} sur {fmtInt(meta.rowCount)}
        </span>
        <label className="inline small">
          Par page
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(0);
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button onClick={() => setPage(0)} disabled={page === 0} aria-label="Première page">
            «
          </button>
          <button onClick={() => setPage((p) => p - 1)} disabled={page === 0} aria-label="Page précédente">
            ‹
          </button>
          <span className="small">
            Page {fmtInt(page + 1)} / {fmtInt(pageCount)}
          </span>
          <button onClick={() => setPage((p) => p + 1)} disabled={page >= pageCount - 1} aria-label="Page suivante">
            ›
          </button>
          <button onClick={() => setPage(pageCount - 1)} disabled={page >= pageCount - 1} aria-label="Dernière page">
            »
          </button>
        </div>
      </div>
    </div>
  );
}
