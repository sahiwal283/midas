import { useEffect, useMemo, useRef, useState } from 'react';

export type SearchableOption = { value: string; label: string; hint?: string };

const MAX_VISIBLE = 80;

/**
 * Combobox-style select: type to filter a long list (Zoho vendors, items,
 * chart-of-accounts). Arrow keys move the highlight, Enter picks, Escape closes.
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Search…',
  disabled,
  className = '',
}: {
  options: SearchableOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) setQuery(selected?.label ?? '');
  }, [open, selected?.label, value]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => (
      o.label.toLowerCase().includes(q)
      || (o.hint?.toLowerCase().includes(q) ?? false)
      || o.value.includes(q)
    ));
  }, [options, query]);

  const filtered = useMemo(() => matches.slice(0, MAX_VISIBLE), [matches]);
  const hiddenCount = matches.length - filtered.length;

  // Keep the highlight in range as the filter narrows.
  useEffect(() => { setHighlight(0); }, [query, open]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  function choose(v: string) {
    onChange(v);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setHighlight((h) => {
        if (filtered.length === 0) return 0;
        const next = e.key === 'ArrowDown' ? h + 1 : h - 1;
        return (next + filtered.length) % filtered.length;
      });
      return;
    }
    if (e.key === 'Enter' && open) {
      const pick = filtered[highlight];
      if (pick) { e.preventDefault(); choose(pick.value); }
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        disabled={disabled}
        className="w-full rounded border border-brand-200 px-3 py-2 text-sm"
        placeholder={placeholder}
        value={open ? query : (selected?.label ?? '')}
        onFocus={() => {
          setOpen(true);
          setQuery(selected?.label ?? '');
        }}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          if (!e.target.value) onChange('');
        }}
      />
      {open && !disabled && (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-brand-200 bg-white text-sm shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-gray-400">No matches</li>
          ) : (
            <>
              {filtered.map((o, idx) => (
                <li key={o.value} data-idx={idx} role="option" aria-selected={o.value === value}>
                  <button
                    type="button"
                    className={`w-full px-3 py-2 text-left hover:bg-brand-50 ${
                      idx === highlight ? 'bg-brand-50' : ''
                    } ${o.value === value ? 'font-medium' : ''}`}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => choose(o.value)}
                  >
                    <span className="block truncate">{o.label}</span>
                    {o.hint && <span className="block truncate text-xs text-gray-400">{o.hint}</span>}
                  </button>
                </li>
              ))}
              {hiddenCount > 0 && (
                <li className="border-t border-brand-100 px-3 py-2 text-xs text-gray-400">
                  {hiddenCount} more — keep typing to narrow
                </li>
              )}
            </>
          )}
        </ul>
      )}
    </div>
  );
}
