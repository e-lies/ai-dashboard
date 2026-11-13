import { useRef, useState } from 'react';
import type { DatasetMeta } from '../../../shared/types';
import { fmtInt } from '../lib/format';
import { importDashboard, parseDashboardFile } from '../lib/transfer';
import { useApp } from '../store';
import { SchemaEditor } from './SchemaEditor';
import { ChatPanel } from './ChatPanel';
import { DataTable } from './DataTable';

export function DatasetView({ meta }: { meta: DatasetMeta }) {
  const { updateDatasetMeta, deleteDataset, createDashboard, addDashboard, dashboards, setView } = useApp();
  const linked = dashboards.filter((d) => d.datasetId === meta.id);
  const [showChat, setShowChat] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function importFile(file: File) {
    setImportError(null);
    try {
      if (file.size > 5_000_000) throw new Error('Fichier trop volumineux pour un dashboard (5 Mo maximum).');
      await addDashboard(importDashboard(parseDashboardFile(await file.text()), meta));
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={`dashboard-layout${showChat ? ' with-chat' : ''}`}>
      <div className="page">
        <div className="page-header">
          <h2>{meta.name}</h2>
          <div className="row">
            <button onClick={() => setShowChat(!showChat)}>{showChat ? 'Masquer le chat' : 'Chatbot'}</button>
            <button className="primary" onClick={() => createDashboard(meta.id, `Dashboard – ${meta.name}`)}>
              Créer un dashboard
            </button>
            <button
              title="Créer un dashboard sur ce jeu à partir d'un fichier exporté (.tqdash.json)"
              onClick={() => fileInput.current?.click()}
            >
              Importer un dashboard
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void importFile(f);
              }}
            />
            <button
              className="danger"
              onClick={() =>
                window.confirm('Supprimer ce jeu de données et ses dashboards ? Cette action est irréversible.') &&
                deleteDataset(meta.id)
              }
            >
              Supprimer
            </button>
          </div>
        </div>
        <p className="muted small">
          {meta.fileName}
          {meta.sheetName ? ` · ${meta.sheetName}` : ''} · {fmtInt(meta.rowCount)} lignes · importé le{' '}
          {new Date(meta.createdAt).toLocaleDateString('fr-CA')}
        </p>
        {importError && (
          <p className="error" role="alert">
            Import impossible : {importError}
          </p>
        )}
  
        {linked.length > 0 && (
          <section className="card">
            <h4>Dashboards</h4>
            <ul>
              {linked.map((d) => (
                <li key={d.id}>
                  <button className="link" onClick={() => setView({ kind: 'dashboard', id: d.id })}>
                    {d.name}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
  
        <section className="card">
          <h4>Schéma</h4>
          <SchemaEditor columns={meta.columns} lockTypes onChange={(columns) => updateDatasetMeta({ ...meta, columns })} />
        </section>
  
        <section className="card">
          <h4>Données</h4>
          <DataTable key={meta.id} meta={meta} />
        </section>
      </div>
      {/* Sans dashboard : le chat répond sur le jeu complet, sans aucun filtre. */}
      {showChat && <ChatPanel key={meta.id} meta={meta} />}
    </div>
  );
}
