/**
 * Sélection multiple de valeurs pour les filtres « parmi » et « hors de » :
 * les valeurs choisies s'affichent en étiquettes, et une liste déroulante avec
 * recherche propose toutes les valeurs distinctes de la colonne.
 *
 * Clavier : flèches pour parcourir, Entrée pour cocher ou décocher (ou ajouter
 * la saisie, plusieurs valeurs séparées par « ; »), Retour arrière pour retirer
 * la dernière étiquette, Échap pour fermer.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ColumnSchema, DatasetMeta } from '../../../shared/types';
import { fmt } from '../lib/format';
import {
  EMPTY_LABEL,
  addValues,
  matchOptions,
  parseInput,
  resolveTyped,
  sortOptions,
  splitInput,
  toggleValue,
  valueKey,
  type FilterValue,
} from '../lib/multiValue';
import { distinctValues } from '../lib/valueMatch';
import { useApp } from '../store';

interface Props {
  meta: DatasetMeta;
  col: ColumnSchema;
  values: FilterValue[];
  onChange(values: FilterValue[]): void;
}

export function MultiValueSelect({ meta, col, values, onChange }: Props) {
  const ensureLoaded = useApp((s) => s.ensureLoaded);
  const [options, setOptions] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  // Les valeurs distinctes ne sont chargées qu'à la première ouverture de la liste.
  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    ensureLoaded(meta.id)
      .then(() => distinctValues(meta, col))
      .then((v) => !cancelled && setOptions(sortOptions(v, col)))
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [open, options, meta, col, ensureLoaded]);

  // Rien n'est proposé avant la fin du chargement, pas même « (vide) ».
  const { items, more } = useMemo(() => (options ? matchOptions(options, query) : { items: [], more: 0 }), [options, query]);
  const selectedKeys = new Set(values.map(valueKey));
  const numeric = col.type === 'number' || col.type === 'integer';
  const label = (v: FilterValue) => (v === null ? EMPTY_LABEL : numeric && typeof v === 'number' ? fmt(v) : String(v));
  const optionValue = (o: string | null): FilterValue => (o === null ? null : parseInput(o, col));

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function toggle(o: string | null) {
    onChange(toggleValue(values, optionValue(o)));
  }

  function commitTyped(raw: string) {
    const typed = resolveTyped(splitInput(raw, col), options ?? []);
    if (typed.length) onChange(addValues(values, typed));
    setQuery('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Saisie de plusieurs valeurs, ou d'une valeur absente de la liste : ajoutée telle quelle.
      if (query.includes(';') || (query.trim() && items.length === 0)) commitTyped(query);
      else if (open && items[active] !== undefined) toggle(items[active]!);
      else setOpen(true);
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Backspace' && !query && values.length) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div
      className="multi-select"
      onBlur={(e) => {
        // Fermeture quand le focus quitte tout le composant (pas en cliquant dans la liste).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setQuery('');
        }
      }}
    >
      <div className="multi-select-box" onClick={() => inputRef.current?.focus()}>
        {values.map((v) => (
          <span key={valueKey(v)} className={`tag${v === null ? ' null' : ''}`}>
            {label(v)}
            <button
              type="button"
              className="tag-remove"
              aria-label={`Retirer ${label(v)}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(toggleValue(values, v));
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={`Valeurs de ${col.name}`}
          aria-activedescendant={open && items.length ? `${listId}-${active}` : undefined}
          value={query}
          placeholder={values.length ? '' : 'Choisir des valeurs…'}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (text.includes(';')) {
              e.preventDefault();
              commitTyped(query + text);
            }
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {open && (
        <ul id={listId} ref={listRef} className="multi-select-list" role="listbox" aria-multiselectable="true">
          {loadError && <li className="error small">Valeurs indisponibles : {loadError}</li>}
          {!options && !loadError && <li className="muted small">Chargement des valeurs…</li>}
          {options && items.length === 0 && (
            <li className="muted small">
              Aucune valeur ne correspond.{query.trim() ? ' Entrée pour l’ajouter quand même.' : ''}
            </li>
          )}
          {items.map((o, i) => {
            const selected = selectedKeys.has(valueKey(optionValue(o)));
            return (
              <li
                key={o ?? '\u0000'}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={selected}
                className={`${i === active ? 'active' : ''}${o === null ? ' null' : ''}`}
                // mousedown : garde le focus dans le champ, la liste reste ouverte pour cocher plusieurs valeurs.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => toggle(o)}
              >
                <span className="check" aria-hidden>
                  {selected ? '☑' : '☐'}
                </span>
                {o === null ? EMPTY_LABEL : numeric ? fmt(Number(o)) : o}
              </li>
            );
          })}
          {more > 0 && <li className="muted small">… et {more.toLocaleString('fr-CA')} autres : affinez la recherche.</li>}
        </ul>
      )}
    </div>
  );
}
