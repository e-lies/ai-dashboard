import { useRef, useState } from 'react';
import type { DatasetMeta } from '../../../shared/types';
import { fmtInt } from '../lib/format';
import { readFile } from '../lib/ingest';
import { prepareRefresh } from '../lib/refresh';
import { importDashboard, parseDashboardFile } from '../lib/transfer';
import { useApp } from '../store';
import { SchemaEditor } from './SchemaEditor';
import { ChatPanel } from './ChatPanel';
import { DataTable } from './DataTable';

export function DatasetView({ meta }: { meta: DatasetMeta }) {
  const { updateDatasetMeta, replaceDatasetData, deleteDataset, createDashboard, addDashboard, dashboards, setView } =
    useApp();
  const linked = dashboards.filter((d) => d.datasetId === meta.id);
  const [showChat, setShowChat] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dataInput = useRef<HTMLInputElement>(null);
  const [refresh, setRefresh] = useState<{ busy?: string; error?: string; done?: string } | null>(null);

  /**
   * Remplace les lignes par celles d'un nouveau fichier. Refusé si une colonne du schéma manque ;
   * les colonnes en trop sont ignorées. Le schéma (et donc les dashboards) ne change pas.
   */
  async function refreshData(file: File) {
    setRefresh({ busy: 'Lecture du fichier…' });
    try {
      const plan = prepareRefresh(meta, await readFile(file));
      if (!plan.ok) {
        setRefresh({
          error:
            `Le fichier « ${file.name} »${plan.sheetName ? ` (onglet ${plan.sheetName})` : ''} ne contient pas toutes les ` +
            `colonnes du jeu de données. Colonnes manquantes : ${plan.missing.join(', ')}.`,
        });
        return;
      }
      const details = [
        `Remplacer les ${fmtInt(meta.rowCount)} lignes actuelles par les ${fmtInt(plan.meta.rowCount)} lignes de « ${file.name} »` +
          `${plan.meta.sheetName ? ` (onglet ${plan.meta.sheetName})` : ''} ?`,
        plan.extra.length ? `\nColonnes du fichier ignorées (absentes du schéma) : ${plan.extra.join(', ')}.` : '',
        plan.rejected.length
          ? `\nValeurs non convertibles, qui seront vides :\n${plan.rejected.map((r) => `  ${r.column} : ${fmtInt(r.count)}`).join('\n')}`
          : '',
        `\n${
          linked.length === 1
            ? 'Le dashboard de ce jeu sera recalculé. '
            : linked.length > 1
              ? `Les ${linked.length} dashboards de ce jeu seront recalculés. `
              : ''
        }Les anciennes lignes ne pourront pas être récupérées.`,
      ];
      if (!window.confirm(details.join('\n'))) {
        setRefresh(null);
        return;
      }
      setRefresh({ busy: 'Chargement des nouvelles données…' });
      await replaceDatasetData(plan.meta, plan.rows);
      setRefresh({ done: `Données mises à jour : ${fmtInt(plan.meta.rowCount)} lignes, depuis « ${file.name} ».` });
    } catch (e) {
      setRefresh({ error: e instanceof Error ? e.message : String(e) });
    }
  }

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
              disabled={!!refresh?.busy}
              title="Remplacer les lignes par celles d'un nouveau fichier contenant toutes les colonnes du schéma"
              onClick={() => dataInput.current?.click()}
            >
              Mettre à jour les données
            </button>
            <input
              ref={dataInput}
              type="file"
              accept=".xlsx,.xls,.xlsm,.ods,.csv,.tsv,.txt"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void refreshData(f);
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
          {meta.updatedAt && ` · mis à jour le ${new Date(meta.updatedAt).toLocaleDateString('fr-CA')}`}
        </p>
        {refresh?.busy && <p className="muted">{refresh.busy}</p>}
        {refresh?.error && (
          <p className="error" role="alert">
            Mise à jour refusée : {refresh.error}
          </p>
        )}
        {refresh?.done && <p className="success" role="status">{refresh.done}</p>}
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
          {/* La clé inclut la date de mise à jour : le tableau repart de la première page avec les nouvelles lignes. */}
          <DataTable key={`${meta.id}:${meta.updatedAt ?? ''}`} meta={meta} />
        </section>
      </div>
      {/* Sans dashboard : le chat répond sur le jeu complet, sans aucun filtre. */}
      {showChat && <ChatPanel key={meta.id} meta={meta} />}
    </div>
  );
}
