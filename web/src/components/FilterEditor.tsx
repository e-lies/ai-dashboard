import type { ColumnSchema, DatasetMeta, Filter, FilterOp } from '../../../shared/types';
import { OP_LABELS } from '../lib/sql';


function opsFor(col: ColumnSchema): FilterOp[] {
  switch (col.type) {
    case 'number':
    case 'integer':
    case 'date':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'isNull', 'notNull'];
    case 'boolean':
      return ['eq', 'neq', 'isNull', 'notNull'];
    default:
      return ['eq', 'neq', 'in', 'notIn', 'contains', 'isNull', 'notNull'];
  }
}

/** Convertit la saisie selon le type de la colonne. « (vide) » désigne la valeur nulle. */
function parseInput(raw: string, col: ColumnSchema): string | number | boolean | null {
  const s = raw.trim();
  if (s === '(vide)') return null;
  if (col.type === 'number' || col.type === 'integer') {
    const n = Number(s.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  if (col.type === 'boolean') return /^(oui|vrai|true|1)$/i.test(s);
  return s;
}

const MULTI: FilterOp[] = ['in', 'notIn', 'between'];

function displayValue(f: Filter): string {
  const show = (v: unknown) => (v === null ? '(vide)' : v === undefined ? '' : String(v));
  return MULTI.includes(f.op) ? (f.values ?? []).map(show).join(' ; ') : show(f.value);
}

interface Props {
  meta: DatasetMeta;
  filters: Filter[];
  onChange(filters: Filter[]): void;
}

export function FilterEditor({ meta, filters, onChange }: Props) {
  const usable = meta.columns.filter((c) => c.role !== 'text');
  const update = (i: number, patch: Partial<Filter>) =>
    onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  return (
    <div className="filters">
      {filters.map((f, i) => {
        const col = meta.columns.find((c) => c.id === f.columnId);
        if (!col) return null;
        const listId = `vals-${col.id}`;
        return (
          <div className="filter-row" key={i}>
            <select
              value={f.columnId}
              onChange={(e) => update(i, { columnId: e.target.value, op: 'eq', value: undefined, values: undefined })}
            >
              {usable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select value={f.op} onChange={(e) => update(i, { op: e.target.value as FilterOp })}>
              {opsFor(col).map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>
            {f.op !== 'isNull' && f.op !== 'notNull' && (
              <>
                <input
                  key={`${f.columnId}-${f.op}`}
                  list={listId}
                  type={col.type === 'date' && !MULTI.includes(f.op) ? 'date' : 'text'}
                  placeholder={MULTI.includes(f.op) ? 'valeurs séparées par « ; »' : 'valeur'}
                  defaultValue={displayValue(f)}
                  onBlur={(e) => {
                    const raw = e.target.value;
                    if (MULTI.includes(f.op)) {
                      update(i, { values: raw.split(';').filter((s) => s.trim() !== '').map((s) => parseInput(s, col)) });
                    } else {
                      update(i, { value: parseInput(raw, col) });
                    }
                  }}
                />
                <datalist id={listId}>
                  {col.stats?.topValues.map((v) => <option key={v.value} value={v.value} />)}
                </datalist>
              </>
            )}
            <button className="icon" title="Retirer" onClick={() => onChange(filters.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        );
      })}
      <button
        className="link"
        onClick={() => usable[0] && onChange([...filters, { columnId: usable[0].id, op: 'eq' }])}
      >
        + Ajouter un filtre
      </button>
    </div>
  );
}
