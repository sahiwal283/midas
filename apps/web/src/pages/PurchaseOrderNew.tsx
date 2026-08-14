import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import api from '../api/client';
import { SearchableSelect } from '../components/SearchableSelect';
import { VendorCombobox } from '../components/VendorCombobox';
import type { Transaction } from '@midas/shared';

type ZohoVendor = { vendorId: string; vendorName: string; companyName?: string | null };
type ZohoItem = { itemId: string; name: string; sku?: string | null; unit?: string | null };

type LineDraft = {
  lineNumber: number;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  tax: string;
  total: string;
  zohoItemId: string;
};

function blankLine(n: number): LineDraft {
  return {
    lineNumber: n,
    description: '',
    quantity: '1',
    unit: '',
    unitPrice: '0',
    tax: '0',
    total: '0',
    zohoItemId: '',
  };
}

function recalc(line: LineDraft): LineDraft {
  const qty = Number(line.quantity) || 0;
  const price = Number(line.unitPrice) || 0;
  const tax = Number(line.tax) || 0;
  return { ...line, total: (qty * price + tax).toFixed(2) };
}

export function PurchaseOrderNew() {
  const navigate = useNavigate();
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: async () => (await api.get<{ companies: Array<{ name: string }> }>('/companies')).data.companies,
  });
  const vendorsQ = useQuery({
    queryKey: ['zoho-vendors'],
    queryFn: async () => (await api.get<{ vendors: ZohoVendor[] }>('/transactions/meta/vendors')).data.vendors,
    staleTime: 60_000,
    retry: 1,
  });
  const itemsQ = useQuery({
    queryKey: ['zoho-items'],
    queryFn: async () => (await api.get<{ items: ZohoItem[] }>('/transactions/meta/items')).data.items,
    staleTime: 60_000,
    retry: 1,
  });

  const [vendorName, setVendorName] = useState('');
  const [zohoVendorId, setZohoVendorId] = useState('');
  const [transactionDate, setTransactionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [zohoEntity, setZohoEntity] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [taxTotal, setTaxTotal] = useState('0');
  const [lines, setLines] = useState<LineDraft[]>([blankLine(1)]);
  const [error, setError] = useState<string | null>(null);

  const items = itemsQ.data ?? [];
  const vendors = vendorsQ.data ?? [];

  const vendorOptions = useMemo(
    () => [...vendors].sort((a, b) => a.vendorName.localeCompare(b.vendorName)),
    [vendors],
  );
  const itemOptions = useMemo(
    () => [...items].sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  );

  function pickVendor(id: string) {
    setZohoVendorId(id);
    const v = vendors.find((x) => x.vendorId === id);
    if (v) setVendorName(v.companyName || v.vendorName);
  }

  function pickItem(idx: number, itemId: string) {
    const item = items.find((x) => x.itemId === itemId);
    const next = [...lines];
    const line = next[idx];
    next[idx] = recalc({
      ...line,
      zohoItemId: itemId,
      description: line.description || item?.name || '',
      unit: line.unit || item?.unit || '',
    });
    setLines(next);
  }

  const create = useMutation({
    mutationFn: async () => {
      const lineItems = lines
        .filter((l) => l.description.trim())
        .map((l, i) => ({
          lineNumber: i + 1,
          description: l.description.trim(),
          quantity: Number(l.quantity),
          unit: l.unit || null,
          unitPrice: Number(l.unitPrice),
          tax: Number(l.tax) || 0,
          total: Number(l.total),
          zohoItemId: l.zohoItemId || null,
        }));
      const { data } = await api.post<{ transaction: Transaction }>('/transactions/purchase-orders', {
        vendorName,
        zohoVendorId: zohoVendorId || null,
        transactionDate,
        zohoEntity: zohoEntity || null,
        poNumber: poNumber || null,
        taxTotal: Number(taxTotal) || 0,
        lineItems,
      });
      return data.transaction;
    },
    onSuccess: (tx) => navigate(`/transactions/${tx.id}`),
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      setError(msg || 'Failed to create purchase order');
    },
  });

  const subtotal = lines.reduce((acc, l) => acc + (Number(l.total) || 0), 0);
  const canSave = !!vendorName.trim() && lines.some((l) => l.description.trim());

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="font-display text-2xl text-ink mb-6">New Purchase Order</h1>
      {error && <p className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>}
      {(vendorsQ.isError || itemsQ.isError) && (
        <p className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Could not load Zoho vendors/items. You can still draft the PO and map IDs later — push will require them.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 mb-6">
        <label className="block text-sm sm:col-span-2">
          <span className="text-charcoal/80">Zoho vendor</span>
          <SearchableSelect
            className="mt-1"
            disabled={vendorsQ.isLoading}
            placeholder={vendorsQ.isLoading ? 'Loading vendors…' : 'Search Zoho vendors…'}
            value={zohoVendorId}
            onChange={(id) => pickVendor(id)}
            options={vendorOptions.map((v) => ({
              value: v.vendorId,
              label: v.companyName || v.vendorName,
              hint: v.vendorId,
            }))}
          />
        </label>
        <label className="block text-sm">
          <span className="text-charcoal/80">Vendor name *</span>
          {/* Type-to-search with create: a brand-new vendor is created in Zoho
              (dedup-checked) and its id fills the Zoho vendor picker above. */}
          <VendorCombobox
            className="mt-1"
            inputClassName="w-full rounded border border-brand-200 px-3 py-2 text-sm"
            placeholder="Search or create a vendor…"
            required
            value={vendorName}
            onChange={setVendorName}
            onVendorPicked={(v) => setZohoVendorId(v.vendorId)}
          />
        </label>
        <label className="block text-sm">
          <span className="text-charcoal/80">Date *</span>
          <input
            type="date"
            className="mt-1 w-full rounded border border-brand-200 px-3 py-2"
            value={transactionDate}
            onChange={(e) => setTransactionDate(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="text-charcoal/80">PO number</span>
          <input className="mt-1 w-full rounded border border-brand-200 px-3 py-2" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-charcoal/80">Company</span>
          <select className="mt-1 w-full rounded border border-brand-200 px-3 py-2" value={zohoEntity} onChange={(e) => setZohoEntity(e.target.value)}>
            <option value="">—</option>
            {(companies.data ?? []).map((c: { name: string }) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
        </label>
      </div>

      <h2 className="text-sm font-semibold text-ink mb-2">Line items</h2>
      <div className="overflow-x-auto border border-brand-100 rounded-lg mb-4">
        <table className="min-w-full text-sm">
          <thead className="bg-brand-50/60 text-left">
            <tr>
              <th className="px-2 py-2">Zoho item</th>
              <th className="px-2 py-2">Description</th>
              <th className="px-2 py-2 w-20">Qty</th>
              <th className="px-2 py-2 w-24">Unit</th>
              <th className="px-2 py-2 w-24">Price</th>
              <th className="px-2 py-2 w-20">Tax</th>
              <th className="px-2 py-2 w-24">Total</th>
              <th className="px-2 py-2 w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => (
              <tr key={line.lineNumber} className="border-t border-brand-100">
                <td className="px-2 py-1 min-w-[12rem]">
                  <SearchableSelect
                    disabled={itemsQ.isLoading}
                    placeholder="Search item…"
                    value={line.zohoItemId}
                    onChange={(id) => pickItem(idx, id)}
                    options={itemOptions.map((it) => ({
                      value: it.itemId,
                      label: it.name,
                      hint: it.sku || it.itemId,
                    }))}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className="w-full rounded border border-brand-200 px-2 py-1"
                    value={line.description}
                    onChange={(e) => {
                      const next = [...lines];
                      next[idx] = { ...line, description: e.target.value };
                      setLines(next);
                    }}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className="w-full rounded border border-brand-200 px-2 py-1"
                    value={line.quantity}
                    onChange={(e) => {
                      const next = [...lines];
                      next[idx] = recalc({ ...line, quantity: e.target.value });
                      setLines(next);
                    }}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className="w-full rounded border border-brand-200 px-2 py-1"
                    value={line.unit}
                    onChange={(e) => {
                      const next = [...lines];
                      next[idx] = { ...line, unit: e.target.value };
                      setLines(next);
                    }}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className="w-full rounded border border-brand-200 px-2 py-1"
                    value={line.unitPrice}
                    onChange={(e) => {
                      const next = [...lines];
                      next[idx] = recalc({ ...line, unitPrice: e.target.value });
                      setLines(next);
                    }}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className="w-full rounded border border-brand-200 px-2 py-1"
                    value={line.tax}
                    onChange={(e) => {
                      const next = [...lines];
                      next[idx] = recalc({ ...line, tax: e.target.value });
                      setLines(next);
                    }}
                  />
                </td>
                <td className="px-2 py-1 font-mono text-xs">{line.total}</td>
                <td className="px-2 py-1">
                  {lines.length > 1 && (
                    <button type="button" className="text-red-600 text-xs" onClick={() => setLines(lines.filter((_, i) => i !== idx))}>✕</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="text-sm text-brand-700 mb-6"
        onClick={() => setLines([...lines, blankLine(lines.length + 1)])}
      >
        + Add line
      </button>

      <div className="flex flex-wrap items-end gap-4 mb-8">
        <label className="block text-sm">
          <span className="text-charcoal/80">Tax total</span>
          <input className="mt-1 w-32 rounded border border-brand-200 px-3 py-2" value={taxTotal} onChange={(e) => setTaxTotal(e.target.value)} />
        </label>
        <div className="text-sm">
          <div className="text-charcoal/60">Subtotal</div>
          <div className="font-semibold">${subtotal.toFixed(2)}</div>
        </div>
        <div className="text-sm">
          <div className="text-charcoal/60">Grand total</div>
          <div className="font-semibold">${(subtotal + (Number(taxTotal) || 0)).toFixed(2)}</div>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          disabled={!canSave || create.isPending}
          onClick={() => create.mutate()}
          className="rounded-lg bg-brand-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {create.isPending ? 'Saving…' : 'Save draft'}
        </button>
        <button type="button" onClick={() => navigate(-1)} className="rounded-lg border border-brand-200 px-4 py-2 text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}
