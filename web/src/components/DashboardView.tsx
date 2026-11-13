import { useState } from 'react';
import type { DashboardSpec, DatasetMeta, WidgetSpec } from '../../../shared/types';
import { exportDashboard, exportFileName, sensitiveFilterColumns } from '../lib/transfer';
import { useApp } from '../store';
import { ChatPanel } from './ChatPanel';
import { FilterEditor } from './FilterEditor';
import { newWidget, WidgetBuilder } from './WidgetBuilder';
import { WidgetView } from './WidgetView';

/** Télécharge le dashboard (widgets, filtres, paramètres) en JSON, sans aucune ligne de données. */
function download(dashboard: DashboardSpec, meta: DatasetMeta) {
  const sensitive = sensitiveFilterColumns(dashboard, meta);
  if (
    sensitive.length &&
    !window.confirm(
      `Les filtres de ce dashboard portent sur des colonnes sensibles (${sensitive.map((c) => c.name).join(', ')}) : ` +
        'leurs valeurs seront écrites dans le fichier. Exporter quand même ?',
    )
  ) {
    return;
  }
  const json = JSON.stringify(exportDashboard(dashboard, meta), null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFileName(dashboard.name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DashboardView({ dashboard, meta }: { dashboard: DashboardSpec; meta: DatasetMeta }) {
  const { saveDashboard, upsertWidget, removeWidget, setGlobalFilters, deleteDashboard } = useApp();
  const [editing, setEditing] = useState<WidgetSpec | null>(null);
  const [showChat, setShowChat] = useState(true);

  if (editing) {
    return (
      <div className="page">
        <h2>{dashboard.widgets.some((w) => w.id === editing.id) ? 'Modifier le widget' : 'Nouveau widget'}</h2>
        <WidgetBuilder
          meta={meta}
          initial={editing}
          globalFilters={dashboard.globalFilters}
          onCancel={() => setEditing(null)}
          onSave={async (w) => {
            await upsertWidget(dashboard.id, w);
            setEditing(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className={`dashboard-layout${showChat ? ' with-chat' : ''}`}>
      <div className="page">
        <div className="page-header">
          <input
            className="title-input"
            defaultValue={dashboard.name}
            onBlur={(e) => e.target.value !== dashboard.name && saveDashboard({ ...dashboard, name: e.target.value })}
          />
          <div className="row">
            <button className="primary" onClick={() => setEditing(newWidget(meta))}>
              + Widget
            </button>
            <button onClick={() => setShowChat(!showChat)}>{showChat ? 'Masquer le chat' : 'Chatbot'}</button>
            <button title="Enregistrer la définition du dashboard (sans les données) dans un fichier" onClick={() => download(dashboard, meta)}>
              Exporter
            </button>
            <button
              className="danger"
              onClick={() => window.confirm('Supprimer ce dashboard ?') && deleteDashboard(dashboard.id)}
            >
              Supprimer
            </button>
          </div>
        </div>
        <p className="muted small">
          Source : {meta.name}
        </p>

        <section className="card">
          <h4>Filtres du dashboard</h4>
          <FilterEditor meta={meta} filters={dashboard.globalFilters} onChange={(f) => setGlobalFilters(dashboard.id, f)} />
        </section>

        {dashboard.widgets.length === 0 && (
          <p className="muted">Aucun widget. Ajoutez-en un, ou épinglez une réponse du chatbot.</p>
        )}

        <div className="grid">
          {dashboard.widgets.map((w) => (
            <div key={w.id} className={`card widget span-${w.span ?? 2}`}>
              <div className="widget-header">
                <h4>{w.title}</h4>
                <div className="row">
                  {!w.sql && (
                    <button className="icon" title="Modifier" onClick={() => setEditing(w)}>
                      ✎
                    </button>
                  )}
                  <button className="icon" title="Retirer" onClick={() => removeWidget(dashboard.id, w.id)}>
                    ×
                  </button>
                </div>
              </div>
              <WidgetView widget={w} meta={meta} globalFilters={dashboard.globalFilters} dashboardId={dashboard.id} />
            </div>
          ))}
        </div>
      </div>
      {showChat && <ChatPanel meta={meta} dashboard={dashboard} />}
    </div>
  );
}
