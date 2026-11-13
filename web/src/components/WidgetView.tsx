import { useEffect, useState } from 'react';
import type { DatasetMeta, Filter, QueryResult, WidgetSpec } from '../../../shared/types';
import { ensureDashboardView, runSpec, runUntrustedSql } from '../lib/db';
import { dashboardViewName } from '../lib/sql';
import { useApp } from '../store';
import { ResultView } from './ResultView';

interface Props {
  widget: WidgetSpec;
  meta: DatasetMeta;
  globalFilters?: Filter[];
  height?: number;
  showSql?: boolean;
  /** Dashboard hôte : les widgets SQL qui interrogent sa vue filtrée suivent ses filtres. */
  dashboardId?: string;
}

export function WidgetView({ widget, meta, globalFilters = [], height, showSql, dashboardId }: Props) {
  const viewName = dashboardId ? dashboardViewName(dashboardId) : null;
  const usesView = !!(widget.sql && viewName && widget.sql.includes(viewName));
  const dataVersion = useApp((s) => s.dataVersion);
  const ensureLoaded = useApp((s) => s.ensureLoaded);
  const [state, setState] = useState<{ result?: QueryResult; error?: string; loading: boolean }>({ loading: true });

  // La spec est sérialisée pour ne relancer la requête que si elle change réellement.
  const key = JSON.stringify([widget.query, widget.sql, globalFilters, dataVersion]);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    (async () => {
      try {
        await ensureLoaded(meta.id);
        if (usesView) await ensureDashboardView(dashboardId!, meta, globalFilters);
        const result = widget.sql
          ? await runUntrustedSql(widget.sql)
          : await runSpec(widget.query, meta, globalFilters);
        if (!cancelled) setState({ result, loading: false });
      } catch (e) {
        if (!cancelled) setState({ error: (e as Error).message, loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, meta]);

  if (state.error) return <p className="error">{state.error}</p>;
  if (!state.result) return <p className="muted">Calcul en cours…</p>;

  return (
    <div className={state.loading ? 'loading' : undefined}>
      <ResultView
        kind={widget.kind}
        result={state.result}
        nDims={widget.sql ? undefined : widget.query.groupBy.length}
        height={height}
      />
      {state.result.truncated && (
        <p className="hint">
          Seuls les {widget.query.groupLimit ?? 10} groupes principaux sont affichés.
        </p>
      )}
      {widget.sql && !usesView && globalFilters.length > 0 && (
        <p className="hint">Les filtres du dashboard ne s’appliquent pas à ce widget (requête du chatbot).</p>
      )}
      {showSql && (
        <details>
          <summary>SQL</summary>
          <pre className="sql">{state.result.sql}</pre>
        </details>
      )}
    </div>
  );
}
