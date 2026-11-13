/**
 * Assistant d'import : fichier → onglet et ligne d'en-tête → profilage
 * (heuristique puis IA) → validation du schéma → chargement.
 */
import { useMemo, useState } from 'react';
import type { ColumnSchema } from '../../../shared/types';
import { buildDataset, profile, refineWithAi } from '../lib/importer';
import { guessHeaderRow, readFile, toTable, type RawCell, type RawWorkbook } from '../lib/ingest';
import { fmtInt } from '../lib/format';
import { useApp } from '../store';
import { SchemaEditor } from './SchemaEditor';

function cellText(v: RawCell): string {
  if (v === null) return '';
  if (v instanceof Date) return v.toLocaleDateString('fr-CA');
  return String(v);
}

export function ImportWizard() {
  const addDataset = useApp((s) => s.addDataset);
  const [wb, setWb] = useState<RawWorkbook | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [name, setName] = useState('');
  const [useAi, setUseAi] = useState(true);
  const [columns, setColumns] = useState<ColumnSchema[] | null>(null);
  const [ambiguous, setAmbiguous] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sheet = wb?.sheets[sheetIdx];
  const table = useMemo(() => (sheet ? toTable(sheet.matrix, headerRow) : null), [sheet, headerRow]);

  async function onFile(file: File) {
    setError(null);
    setColumns(null);
    setBusy('Lecture du fichier…');
    try {
      const book = await readFile(file);
      setWb(book);
      setSheetIdx(0);
      setHeaderRow(guessHeaderRow(book.sheets[0]?.matrix ?? []));
      setName(file.name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function analyze() {
    if (!table) return;
    setError(null);
    setNotice(null);
    const heuristics = profile(table);
    setAmbiguous(new Set(heuristics.filter((h) => h.dateAmbiguous).map((h) => h.schema.id)));
    setColumns(heuristics.map((h) => h.schema));
    if (!useAi) return;
    setBusy('Analyse des colonnes par l’IA…');
    try {
      setColumns(await refineWithAi(name, table, heuristics));
    } catch (e) {
      setNotice(`L’analyse IA a échoué (${(e as Error).message}). Le typage heuristique est conservé.`);
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (!table || !columns || !wb) return;
    setBusy('Chargement des données…');
    try {
      const built = buildDataset(name || wb.fileName, wb.fileName, sheet?.name, table, columns);
      const rejected = columns
        .filter((c) => (built.rejected[c.id] ?? 0) > 0)
        .map((c) => `${c.name} : ${fmtInt(built.rejected[c.id]!)}`);
      if (
        rejected.length &&
        !window.confirm(`Certaines valeurs n’ont pas pu être converties et seront vides :\n${rejected.join('\n')}\n\nContinuer ?`)
      ) {
        return;
      }
      await addDataset(built.meta, built.rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <h2>Importer des données</h2>
      <p className="muted">
        Les données restent dans votre navigateur. Seuls les noms de colonnes et un court échantillon masqué (aucun pour
        les colonnes sensibles) sont transmis à l’IA. Utilisez de préférence des fichiers sans renseignements personnels.
      </p>

      <input type="file" accept=".xlsx,.xls,.xlsm,.ods,.csv,.tsv,.txt" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />

      {wb && sheet && table && (
        <section className="card">
          <div className="row wrap">
            <label>
              Nom du jeu de données
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            {wb.sheets.length > 1 && (
              <label>
                Onglet
                <select
                  value={sheetIdx}
                  onChange={(e) => {
                    const i = Number(e.target.value);
                    setSheetIdx(i);
                    setHeaderRow(guessHeaderRow(wb.sheets[i]?.matrix ?? []));
                    setColumns(null);
                  }}
                >
                  {wb.sheets.map((s, i) => (
                    <option key={s.name} value={i}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Ligne d’en-tête
              <input
                type="number"
                min={1}
                value={headerRow + 1}
                onChange={(e) => {
                  setHeaderRow(Math.max(0, Number(e.target.value) - 1));
                  setColumns(null);
                }}
              />
            </label>
            <label className="inline">
              <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
              Analyse par l’IA
            </label>
          </div>

          <p className="muted small">
            {fmtInt(table.rows.length)} lignes · {table.headers.length} colonnes — aperçu :
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  {table.headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j}>{cellText(v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="actions">
            <button className="primary" disabled={!!busy} onClick={analyze}>
              Analyser les colonnes
            </button>
          </div>
        </section>
      )}

      {busy && <p className="muted">{busy}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p className="warn">{notice}</p>}

      {columns && (
        <section className="card">
          <h3>Schéma détecté</h3>
          <p className="muted small">Vérifiez les types, les formats de date et les rôles avant d’importer.</p>
          <SchemaEditor columns={columns} onChange={setColumns} ambiguousDates={ambiguous} />
          <div className="actions">
            <button className="primary" disabled={!!busy} onClick={confirm}>
              Importer
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
