import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle2 } from 'lucide-react';
import client from '../api/client';

export interface ZohoVendorOption {
  vendorId: string;
  vendorName: string;
}

/** Client-side dedup key — case/punctuation-insensitive (server re-checks with the full normalizer). */
function vendorKeyLite(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const MAX_VISIBLE = 50;

/**
 * Merchant field backed by the Zoho vendor list: type-to-search (case-
 * insensitive), free text allowed, and a "create vendor" action when the name
 * is new. Picking a suggestion snaps to the vendor's canonical spelling so
 * "walmart" never creates a twin of "Walmart"; creation is deduplicated
 * server-side too.
 */
export function VendorCombobox({
  value,
  onChange,
  onVendorPicked,
  zohoEntity,
  placeholder = 'Coffee Shop, Airline, etc.',
  className = '',
  inputClassName = '',
  required,
}: {
  value: string;
  onChange: (merchant: string) => void;
  /** Fires with the full vendor when an existing one is picked or a new one is created. */
  onVendorPicked?: (vendor: ZohoVendorOption) => void;
  /** Company whose Zoho org's vendors to search; empty falls back to the default brand. */
  zohoEntity?: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  required?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [notice, setNotice] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const { data: vendors = [] } = useQuery({
    queryKey: ['vendors', zohoEntity ?? ''],
    queryFn: () => client.get<{ vendors: ZohoVendorOption[] }>('/vendors', {
      params: zohoEntity ? { zohoEntity } : undefined,
    }).then((r) => r.data.vendors),
    staleTime: 60_000,
    retry: 1,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      client.post<{ vendor: ZohoVendorOption; existed: boolean }>('/vendors', {
        name,
        zohoEntity: zohoEntity || undefined,
      }).then((r) => r.data),
    onSuccess: ({ vendor, existed }) => {
      onChange(vendor.vendorName);
      onVendorPicked?.(vendor);
      setNotice(existed
        ? `Matched existing vendor “${vendor.vendorName}”`
        : `Vendor “${vendor.vendorName}” created in Zoho`);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['vendors'] });
      void qc.invalidateQueries({ queryKey: ['zoho-vendors'] });
    },
    onError: () => {
      // Creation is a convenience — the typed name still works as merchant
      // text, and push-time vendor resolution has its own dedup + create.
      setNotice('Could not reach Zoho — the name will be linked when the expense is pushed.');
      setOpen(false);
    },
  });

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const query = value.trim();
  const matches = useMemo(() => {
    if (!query) return vendors;
    const q = query.toLowerCase();
    return vendors.filter((v) => v.vendorName.toLowerCase().includes(q));
  }, [vendors, query]);
  const visible = matches.slice(0, MAX_VISIBLE);

  // Exact (normalized) match → no create row; near-match rows already rank in the list.
  const hasExact = useMemo(
    () => !!query && vendors.some((v) => vendorKeyLite(v.vendorName) === vendorKeyLite(query)),
    [vendors, query],
  );
  const showCreate = !!query && !hasExact;
  const optionCount = visible.length + (showCreate ? 1 : 0);

  useEffect(() => { setHighlight(0); }, [query, open]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  function pick(idx: number) {
    if (idx < visible.length) {
      onChange(visible[idx].vendorName);
      onVendorPicked?.(visible[idx]);
      setNotice('');
      setOpen(false);
    } else if (showCreate) {
      createMutation.mutate(query);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setHighlight((h) => {
        if (optionCount === 0) return 0;
        const next = e.key === 'ArrowDown' ? h + 1 : h - 1;
        return (next + optionCount) % optionCount;
      });
      return;
    }
    if (e.key === 'Enter' && open && optionCount > 0) {
      e.preventDefault();
      pick(highlight);
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
        required={required}
        value={value}
        placeholder={placeholder}
        className={inputClassName}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          onChange(e.target.value);
          setNotice('');
          setOpen(true);
        }}
      />
      {open && (visible.length > 0 || showCreate) && (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-brand-200 bg-white text-sm shadow-lg"
        >
          {visible.map((v, idx) => (
            <li key={v.vendorId} data-idx={idx} role="option" aria-selected={v.vendorName === value}>
              <button
                type="button"
                className={`w-full px-3 py-2 text-left hover:bg-brand-50 ${idx === highlight ? 'bg-brand-50' : ''}`}
                onMouseEnter={() => setHighlight(idx)}
                onClick={() => pick(idx)}
              >
                <span className="block truncate">{v.vendorName}</span>
              </button>
            </li>
          ))}
          {showCreate && (
            <li data-idx={visible.length} role="option" aria-selected={false} className="border-t border-brand-100">
              <button
                type="button"
                disabled={createMutation.isPending}
                className={`flex w-full items-center gap-1.5 px-3 py-2 text-left font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-60 ${
                  highlight === visible.length ? 'bg-brand-50' : ''
                }`}
                onMouseEnter={() => setHighlight(visible.length)}
                onClick={() => pick(visible.length)}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                {createMutation.isPending ? 'Creating…' : `Create vendor “${query}”`}
              </button>
            </li>
          )}
        </ul>
      )}
      {notice && (
        <p className="mt-1 flex items-center gap-1 text-xs text-teal-700">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          {notice}
        </p>
      )}
    </div>
  );
}
