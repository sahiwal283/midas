import { useEffect, useMemo, useRef, useState } from 'react';

export type SearchableOption = { value: string; label: string };

/**
 * Type-to-filter combobox for the extension popup (inline styles — no Tailwind).
 * Opening starts a fresh search so the previous selection does not hide the list.
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Search…',
  disabled,
  style,
}: {
  options: SearchableOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);

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
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => { setHighlight(0); }, [query, open]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  function choose(v: string) {
    onChange(v);
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); setQuery(''); return; }
      setHighlight((h) => {
        if (matches.length === 0) return 0;
        const next = e.key === 'ArrowDown' ? h + 1 : h - 1;
        return (next + matches.length) % matches.length;
      });
      return;
    }
    if (e.key === 'Enter' && open) {
      const pick = matches[highlight];
      if (pick) { e.preventDefault(); choose(pick.value); }
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={placeholder}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={open ? query : (selected?.label ?? '')}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          const next = e.target.value;
          setQuery(next);
          setOpen(true);
          if (!next) onChange('');
        }}
        style={{ ...style, paddingRight: 22 }}
      />
      <span
        aria-hidden
        style={{
          position: 'absolute',
          right: 8,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 0,
          height: 0,
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderTop: '5px solid #9ca3af',
          pointerEvents: 'none',
        }}
      />
      {open && !disabled && (
        <ul
          ref={listRef}
          role="listbox"
          style={{
            position: 'absolute',
            zIndex: 50,
            left: 0,
            right: 0,
            margin: '4px 0 0',
            maxHeight: 220,
            overflow: 'auto',
            listStyle: 'none',
            padding: 0,
            border: '1px solid #d1d5db',
            borderRadius: 8,
            background: 'white',
            boxShadow: '0 8px 20px rgba(0,0,0,0.12)',
          }}
        >
          {matches.length === 0 ? (
            <li style={{ padding: '8px 10px', fontSize: 12, color: '#9ca3af' }}>No matches</li>
          ) : (
            matches.map((o, idx) => (
              <li key={o.value || '__empty'} data-idx={idx} role="option" aria-selected={o.value === value}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(idx)}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => choose(o.value)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '7px 10px',
                    fontSize: 13,
                    border: 'none',
                    background: idx === highlight ? '#fdf8f3' : 'white',
                    fontWeight: o.value === value ? 600 : 400,
                    color: '#111827',
                    cursor: 'pointer',
                  }}
                >
                  {o.label}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
