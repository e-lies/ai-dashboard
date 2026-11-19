import { useEffect, useState } from 'react';
import { DashboardView } from './components/DashboardView';
import { DataTable } from './components/DataTable';
import { DatasetView } from './components/DatasetView';
import { ImportWizard } from './components/ImportWizard';
import { useApp } from './store';

export function App() {
  const { ready, init, datasets, dashboards, view, setView } = useApp();
  const [homeDatasetId, setHomeDatasetId] = useState<string | null>(null);

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) return <p className="muted page">Chargement…</p>;

  let main;
  if (view.kind === 'import') main = <ImportWizard />;
  else if (view.kind === 'dataset') {
    const meta = datasets.find((d) => d.id === view.id);
    main = meta ? <DatasetView meta={meta} /> : null;
  } else if (view.kind === 'dashboard') {
    const dash = dashboards.find((d) => d.id === view.id);
    const meta = dash && datasets.find((d) => d.id === dash.datasetId);
    main = dash && meta ? <DashboardView key={dash.id} dashboard={dash} meta={meta} /> : null;
  }

  if (!main) {
    // Accueil : le jeu de données choisi, sinon le plus récent.
    const recent = [...datasets].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const homeMeta = recent.find((d) => d.id === homeDatasetId) ?? recent[0];
    main = (
      <div className="page">
        <h2>Bienvenue</h2>
        <p className="muted">Importez un fichier Excel ou CSV pour commencer, puis créez un dashboard.</p>
        <button className="primary" onClick={() => setView({ kind: 'import' })}>
          Importer des données
        </button>
        {homeMeta && (
          <section className="card">
            <div className="page-header">
              <h4>Données</h4>
              <label className="inline small">
                Jeu de données
                <select value={homeMeta.id} onChange={(e) => setHomeDatasetId(e.target.value)}>
                  {recent.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <DataTable key={`${homeMeta.id}:${homeMeta.updatedAt ?? ''}`} meta={homeMeta} />
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <h1 onClick={() => setView({ kind: 'home' })}>TQ Dashboard</h1>
        <button className="primary block" onClick={() => setView({ kind: 'import' })}>
          + Importer
        </button>

        <h5>Jeux de données</h5>
        {datasets.length === 0 && <p className="muted small">Aucun</p>}
        {datasets.map((d) => (
          <button
            key={d.id}
            className={`nav-item${view.kind === 'dataset' && view.id === d.id ? ' active' : ''}`}
            onClick={() => setView({ kind: 'dataset', id: d.id })}
          >
            {d.name}
          </button>
        ))}

        <h5>Dashboards</h5>
        {dashboards.length === 0 && <p className="muted small">Aucun</p>}
        {dashboards.map((d) => (
          <button
            key={d.id}
            className={`nav-item${view.kind === 'dashboard' && view.id === d.id ? ' active' : ''}`}
            onClick={() => setView({ kind: 'dashboard', id: d.id })}
          >
            {d.name}
          </button>
        ))}
      </nav>
      <main>{main}</main>
    </div>
  );
}
