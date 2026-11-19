import { useEffect, useState } from 'react';
import type { ColumnRole, ColumnSchema, ColumnType } from '../../../shared/types';
import { KNOWN_PATTERNS } from '../lib/dates';
import { fmt, fmtInt } from '../lib/format';

const TYPES: { value: ColumnType; label: string }[] = [
  { value: 'string', label: 'Texte' },
  { value: 'integer', label: 'Entier' },
  { value: 'number', label: 'Nombre' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Booléen' },
];

const ROLES: { value: ColumnRole; label: string }[] = [
  { value: 'dimension', label: 'Dimension' },
  { value: 'measure', label: 'Mesure' },
  { value: 'temporal', label: 'Temporel' },
  { value: 'identifier', label: 'Identifiant' },
  { value: 'text', label: 'Texte libre' },
];

const SOURCE_LABEL = { heuristic: 'heuristique', ai: 'IA', user: 'manuel' } as const;

interface Props {
  columns: ColumnSchema[];
  onChange(columns: ColumnSchema[]): void;
  /** Après l'import, le type n'est plus modifiable (les valeurs sont déjà converties). */
  lockTypes?: boolean;
  ambiguousDates?: Set<string>;
}

export const DESCRIPTION_MAX = 500;

/**
 * Description d'une colonne, transmise telle quelle au chatbot avec le schéma : elle l'aide à comprendre la colonne.
 * Enregistrée à la sortie du champ, pour ne pas sauvegarder à chaque frappe.
 */
function DescriptionInput({ value, onSave }: { value: string; onSave(v: string | null): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const clean = draft.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX);
    if (clean !== value.trim()) onSave(clean || null);
    setDraft(clean);
  };
  return (
    <textarea
      className="col-description"
      rows={2}
      maxLength={DESCRIPTION_MAX}
      value={draft}
      placeholder="Description pour le chatbot (ex. montant de la vente, taxes incluses)"
      aria-label="Description de la colonne"
      title="Transmise à l’IA avec le schéma. N’y mettez aucune donnée réelle ni renseignement personnel."
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
        }
      }}
    />
  );
}

export function SchemaEditor({ columns, onChange, lockTypes, ambiguousDates }: Props) {
  const update = (id: string, patch: Partial<ColumnSchema>) =>
    onChange(columns.map((c) => (c.id === id ? { ...c, ...patch, source: 'user' } : c)));

  return (
    <div className="table-wrap">
      <table className="data schema">
        <thead>
          <tr>
            <th>Colonne</th>
            <th>Type</th>
            <th>Format de date</th>
            <th>Rôle</th>
            <th title="Renseignements personnels probables : signalés notamment à l'export d'un dashboard">Sensible</th>
            <th>Statistiques</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.id}>
              <td className="col-name">
                <strong>{c.name}</strong>
                <DescriptionInput value={c.description ?? ''} onSave={(description) => update(c.id, { description })} />
              </td>
              <td>
                <select disabled={lockTypes} value={c.type} onChange={(e) => update(c.id, { type: e.target.value as ColumnType })}>
                  {TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                {c.type === 'date' && (
                  <>
                    <input
                      list="date-patterns"
                      disabled={lockTypes}
                      value={c.datePattern ?? ''}
                      placeholder="natif Excel"
                      onChange={(e) => update(c.id, { datePattern: e.target.value || null })}
                    />
                    {ambiguousDates?.has(c.id) && c.source === 'heuristic' && (
                      <div className="warn small">Jour/mois ambigu : à vérifier</div>
                    )}
                  </>
                )}
              </td>
              <td>
                <select value={c.role} onChange={(e) => update(c.id, { role: e.target.value as ColumnRole })}>
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="center">
                <input type="checkbox" checked={c.sensitive} onChange={(e) => update(c.id, { sensitive: e.target.checked })} />
              </td>
              <td className="small">
                {c.stats ? (
                  <>
                    {fmtInt(c.stats.distinctCount)} distinctes · {fmtInt(c.stats.nullCount)} vides
                    {c.stats.min !== undefined && (
                      <div className="muted">
                        {fmt(c.stats.min)} → {fmt(c.stats.max ?? null)}
                      </div>
                    )}
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td className="small muted">{SOURCE_LABEL[c.source]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <datalist id="date-patterns">
        {KNOWN_PATTERNS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </div>
  );
}
