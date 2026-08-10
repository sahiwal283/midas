import { useEffect, useMemo, useRef, useState } from 'react';

export type SearchableOption = { value: string; label: string; hint?: string };

/**
 * Combobox-style select: type to filter a long Zoho vendor/item list.
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
  const rootRef = useRef<HTMLDivElement>(null);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 80);
    return options
      .filter((o) => o.label.toLowerCase().includes(q) || (o.hint?.toLowerCase().includes(q) ?? false) || o.value.includes(q))
      .slice(0, 80);
  }, [options, query]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <input
        type="text"
        disabled={disabled}
        className="w-full rounded border border-brand-200 px-3 py-2 text-sm"
        placeholder={placeholder}
        value={open ? query : (selected?.label ?? '')}
        onFocus={() => {
          setOpen(true);
          setQuery(selected?.label ?? '');
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          if (!e.target.value) onChange('');
        }}
      />
      {open && !disabled && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-brand-200 bg-white shadow-lg text-sm">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-gray-400">No matches</li>
          ) : (
            filtered.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  className={`w-full px-3 py-2 text-left hover:bg-brand-50 ${o.value === value ? 'bg-brand-50 font-medium' : ''}`}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <span className="block truncate">{o.label}</span>
                  {o.hint && <span className="block truncate text-xs text-gray-400">{o.hint}</span>}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
