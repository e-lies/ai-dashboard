import type { ColumnSchema, DatasetMeta, Filter, FilterOp } from '../../../shared/types';
import { parseInput } from '../lib/multiValue';
import { OP_LABELS } from '../lib/sql';
import { MultiValueSelect } from './MultiValueSelect';

/** Opérateurs à plusieurs valeurs choisies dans une liste. */
const LIST_OPS: FilterOp[] = ['in', 'notIn'];

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

/**
 * Changement d'opérateur : la valeur saisie est conservée quand c'est possible
 * (« = Montréal » devient « parmi Montréal », et inversement avec la première valeur).
 */
function changeOp(f: Filter, op: FilterOp): Partial<Filter> {
  const toList = LIST_OPS.includes(op);
  const fromList = LIST_OPS.includes(f.op);
  if (toList && !fromList) return { op, values: f.value !== undefined ? [f.value] : [], value: undefined };
  if (!toList && fromList && op !== 'between') return { op, value: f.values?.[0], values: undefined };
  return { op };
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
            <select value={f.op} onChange={(e) => update(i, changeOp(f, e.target.value as FilterOp))}>
              {opsFor(col).map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>
            {LIST_OPS.includes(f.op) && (
              <MultiValueSelect meta={meta} col={col} values={f.values ?? []} onChange={(values) => update(i, { values })} />
            )}
            {f.op !== 'isNull' && f.op !== 'notNull' && !LIST_OPS.includes(f.op) && (
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
