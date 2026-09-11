import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api/client';
import { transactionReceiptApi } from '../api/expenses';
import { compressReceiptImage } from '../lib/receiptCompress';
import { LineItemReview, LOW_CONFIDENCE } from '../components/LineItemReview';
import { VendorCombobox } from '../components/VendorCombobox';
import { ReceiptAttachments } from '../components/ReceiptAttachments';
import { lineDraftsFromOcr, poHeaderFromOcr, type LineDraft } from '../lib/ocrLineItems';
import { takePendingCapture } from '../lib/pendingCapture';
import type { Transaction } from '@midas/shared';
import type { Receipt } from '../types';

type ZohoItem = { itemId: string; name: string; sku?: string | null; unit?: string | null };

// Shared so the OCR handoff can `ensureQueryData` the same cache entry the
// form renders from: OCR finishes while the catalogue may still be in flight,
// and matching against an empty catalogue would silently preselect nothing.
// Keyed by company because items live per Zoho org — one cache entry per brand,
// never one shared list that could hand another brand's item ids to this PO.
function itemsQueryOptions(zohoEntity: string) {
  return {
    queryKey: ['zoho-items', zohoEntity],
    queryFn: async () => (await api.get<{ items: ZohoItem[] }>('/transactions/meta/items', {
      params: zohoEntity ? { zohoEntity } : undefined,
    })).data.items,
    staleTime: 60_000,
    retry: 1,
    enabled: !!zohoEntity,
  };
}

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
    ocrConfidence: null,
    matchScore: null,
  };
}

export function PurchaseOrderNew() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: async () => (await api.get<{ companies: Array<{ name: string }> }>('/companies')).data.companies,
  });

  const [vendorName, setVendorName] = useState('');
  const [zohoVendorId, setZohoVendorId] = useState('');
  const [transactionDate, setTransactionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [zohoEntity, setZohoEntity] = useState('');
  const itemsQ = useQuery(itemsQueryOptions(zohoEntity));
  const [taxTotal, setTaxTotal] = useState('0');
  const [lines, setLines] = useState<LineDraft[]>([blankLine(1)]);
  const [error, setError] = useState<string | null>(null);
  // The draft this photo belongs to. Held in state so a retaken photo reuses
  // the same purchase order instead of leaving an orphan behind.
  const [draftId, setDraftId] = useState<string | null>(null);
  const [ocrPhase, setOcrPhase] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');

  const items = itemsQ.data ?? [];

  const itemOptions = useMemo(
    () => [...items]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((it) => ({ value: it.itemId, label: it.name, hint: it.sku || it.itemId, unit: it.unit })),
    [items],
  );

  /**
   * Vendor and item ids belong to one company's Zoho org, so changing the
   * company invalidates every id on the form. The typed vendor name and the
   * line descriptions stay — those are what the user (or OCR) actually read —
   * but the ids are dropped rather than pushed against the wrong org.
   */
  function setCompany(name: string) {
    if (name === zohoEntity) return;
    setZohoEntity(name);
    setZohoVendorId('');
    setLines((prev) => prev.map((l) => (l.zohoItemId ? { ...l, zohoItemId: '', matchScore: null } : l)));
  }

  async function ensureDraftId(): Promise<string> {
    if (draftId) return draftId;
    const { data } = await api.post<{ transaction: Transaction }>('/transactions/purchase-orders', {
      vendorName: '',
      transactionDate,
      lineItems: [],
    });
    setDraftId(data.transaction.id);
    return data.transaction.id;
  }

  /** OCR prefill from the first receipt: header fields, then line items. */
  async function applyPoOcr(uploaded: Receipt) {
    setOcrPhase('working');
    try {
      const header = poHeaderFromOcr(uploaded.ocrData);
      if (header.vendorName) setVendorName(header.vendorName);
      if (header.transactionDate) setTransactionDate(header.transactionDate);
      if (header.taxTotal) setTaxTotal(header.taxTotal);
      const catalogue = zohoEntity
        ? await queryClient.ensureQueryData(itemsQueryOptions(zohoEntity)).catch(() => [] as ZohoItem[])
        : [];
      const drafts = lineDraftsFromOcr(uploaded.ocrData, catalogue);
      if (drafts.length) setLines(drafts);
      setOcrPhase('done');
    } catch {
      setOcrPhase('failed');
      setError('The receipt could not be read. Enter the details by hand — the photo is saved.');
    }
  }

  // ?mode=scan: the mobile nav takes the photo inside the tap gesture (a
  // programmatic click after navigation is blocked on mobile) and hands it over.
  const consumedCapture = useRef(false);
  useEffect(() => {
    if (params.get('mode') !== 'scan' || consumedCapture.current) return;
    const captured = takePendingCapture();
    if (!captured) return;
    consumedCapture.current = true;
    void (async () => {
      const id = await ensureDraftId();
      const { receipt: uploaded } = await transactionReceiptApi.upload(id, await compressReceiptImage(captured));
      await applyPoOcr(uploaded);
    })().catch(() => setError('We could not upload that photo. Add it again below.'));
  }, [params]);

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
          ocrConfidence: l.ocrConfidence,
          needsReview: l.ocrConfidence != null && l.ocrConfidence < LOW_CONFIDENCE,
        }));
      const body = {
        vendorName,
        zohoVendorId: zohoVendorId || null,
        transactionDate,
        zohoEntity: zohoEntity || null,
        taxTotal: Number(taxTotal) || 0,
        lineItems,
      };

      // A draft already exists whenever a receipt was picked — patch it rather
      // than creating a second purchase order for the same photo.
      const { data } = draftId
        ? await api.patch<{ transaction: Transaction }>(`/transactions/${draftId}`, body)
        : await api.post<{ transaction: Transaction }>('/transactions/purchase-orders', body);
      const tx = data.transaction;
      // Every photo is already attached to the draft by the strip before Save
      // ever runs — there is nothing left to upload here.
      return { tx, receiptError: null };
    },
    onSuccess: ({ tx }) => navigate(`/transactions/${tx.id}`),
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      setError(msg || 'Failed to save purchase order');
    },
  });

  const subtotal = lines.reduce((acc, l) => acc + (Number(l.total) || 0), 0);
  const unmappedLines = lines.some((l) => l.description.trim() && !l.zohoItemId);
  // A description is what makes a line real: the save filter drops lines without
  // one, and the API requires it. OCR can hand back a line whose amounts read
  // fine but whose text did not, so it shows on screen with numbers filled in
  // and would then disappear at save without a word. Say so, and hold Save until
  // the line is either named or removed — Save is also the approval here, so a
  // line the user saw must not be missing from what reaches Zoho.
  const droppedLines = lines.some(
    (l) => !l.description.trim() && (Number(l.total) || Number(l.unitPrice) || Number(l.tax)),
  );
  // The company is required, not optional. Save is also the approval here, and
  // with no company the submit gate reads the PO as "Zoho not applicable": it
  // skips every Zoho check, approves, and never pushes. The detail page has no
  // company field and there is no PO list, so such a record can be neither
  // fixed nor found afterwards. Cheaper to insist up front.
  const canSave = !!vendorName.trim() && !!zohoEntity
    && lines.some((l) => l.description.trim()) && !droppedLines;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 pb-[calc(7rem+env(safe-area-inset-bottom))] sm:pb-8">
      <h1 className="page-title mb-6">New Purchase Order</h1>
      {error && <p className="mb-4 text-sm text-danger bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>}
      {itemsQ.isError && (
        <p className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Could not load {zohoEntity}'s Zoho items. You can still draft the PO and map IDs later — push will require them.
        </p>
      )}

      {ocrPhase !== 'idle' && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-ink/10 bg-white p-4 shadow-panel">
          <div className="min-w-0 flex-1">
            {ocrPhase === 'working' ? (
              <>
                <p className="flex items-center gap-2 text-sm text-charcoal/70">
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                  Reading the receipt…
                </p>
                <button
                  type="button"
                  onClick={() => setOcrPhase('idle')}
                  className="mt-2 min-h-11 text-sm font-medium text-brand-700"
                >
                  Enter manually instead
                </button>
              </>
            ) : (
              <p className="text-sm text-charcoal/70">
                {ocrPhase === 'done'
                  ? 'Receipt attached. Check the lines below before saving.'
                  : 'Receipt attached.'}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 mb-6">
        {/* Company leads the form: vendors and items are per-Zoho-org, so it is
            the answer that decides which of them this PO may even reference. */}
        <label className="block text-sm sm:col-span-2">
          <span className="text-charcoal/80">Company *</span>
          <select
            required
            className="mt-1 w-full rounded border border-brand-200 px-3 py-3 lg:py-2"
            value={zohoEntity}
            onChange={(e) => setCompany(e.target.value)}
          >
            <option value="">Select a company…</option>
            {(companies.data ?? []).map((c: { name: string }) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-charcoal/80">Vendor *</span>
          {/* One field, not two: type to search this company's Zoho vendors, or
              create one there (dedup-checked). The picked vendor's id rides
              along in state and is what the push uses. */}
          <VendorCombobox
            className="mt-1"
            inputClassName="w-full rounded border border-brand-200 px-3 py-3 lg:py-2 text-sm disabled:bg-ink/[0.04] disabled:text-charcoal/40"
            placeholder={zohoEntity ? 'Search or create a vendor…' : 'Pick a company first'}
            required
            disabled={!zohoEntity}
            zohoEntity={zohoEntity || undefined}
            value={vendorName}
            onChange={(name) => { setVendorName(name); setZohoVendorId(''); }}
            onVendorPicked={(v) => setZohoVendorId(v.vendorId)}
          />
          {!zohoEntity ? (
            <span className="mt-1 block text-xs text-charcoal/50">
              Pick a company first — vendors are specific to it.
            </span>
          ) : zohoVendorId ? (
            <span className="mt-1 block text-xs text-success">Linked to a {zohoEntity} vendor in Zoho.</span>
          ) : vendorName.trim() ? (
            <span className="mt-1 block text-xs text-charcoal/50">
              Not linked yet — pick a suggestion or create it, or it will be matched when this PO is pushed.
            </span>
          ) : null}
        </label>
        <label className="block text-sm">
          <span className="text-charcoal/80">Date *</span>
          <input
            type="date"
            className="mt-1 w-full rounded border border-brand-200 px-3 py-3 lg:py-2"
            value={transactionDate}
            onChange={(e) => setTransactionDate(e.target.value)}
          />
        </label>
        <div className="block text-sm sm:col-span-2">
          <span className="text-charcoal/80">Receipts</span>
          <div className="mt-1">
            <ReceiptAttachments
              kind="transaction"
              ownerId={draftId}
              ensureOwnerId={ensureDraftId}
              onFirstReceipt={(r) => void applyPoOcr(r)}
            />
          </div>
        </div>
      </div>

      <h2 className="text-sm font-semibold text-ink mb-2">Line items</h2>

      <LineItemReview
        lines={lines}
        onChange={setLines}
        itemOptions={itemOptions}
        itemsLoading={!zohoEntity || itemsQ.isLoading}
      />

      <button
        type="button"
        className="w-full sm:w-auto min-h-11 sm:min-h-0 rounded-lg border border-brand-200 sm:border-0 text-sm text-brand-700 mb-6"
        onClick={() => setLines([...lines, blankLine(Math.max(0, ...lines.map((l) => l.lineNumber)) + 1)])}
      >
        + Add line
      </button>

      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end mb-8">
        <label className="block text-sm">
          <span className="text-charcoal/80">Tax total</span>
          <input
            inputMode="decimal"
            className="mt-1 w-full sm:w-32 rounded border border-brand-200 px-3 py-3 lg:py-2"
            value={taxTotal}
            onChange={(e) => setTaxTotal(e.target.value)}
          />
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

      {/* Sticky so Save is always reachable on a phone, but not at bottom-0:
          MobileNav is fixed over the foot of the viewport and its camera FAB
          overhangs it by 20px, reaching 5rem up on a device with no home
          indicator. env(safe-area-inset-bottom) pads the nav from underneath and
          so pushes the FAB up by the same amount, which is why the inset is
          added rather than relied on for clearance. The offset pins the bottom
          edge, so the notices below can grow the bar upward without eating it.

          The notices live inside the bar rather than above it: one of them
          explains why Save is disabled, and in normal flow it would scroll off
          the top while the bar stayed pinned, leaving a greyed button with no
          stated cause. They travel with the button they explain. */}
      <div className="sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] -mx-4 border-t border-ink/10 bg-cream px-4 py-3 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
        {droppedLines && (
          <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            A line has amounts but no description, so it would not be saved. Describe it or remove it to continue.
          </p>
        )}

        {unmappedLines && (
          <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Some lines have no Zoho item yet. You can save this draft now, but every line needs one before you can submit it.
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            disabled={!canSave || create.isPending}
            onClick={() => create.mutate()}
            className="w-full sm:w-auto min-h-11 sm:min-h-0 rounded-lg bg-brand-700 text-cream px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {create.isPending ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            onClick={async () => {
              // An abandoned draft has a real row and a stored file behind it.
              // Cancel hard-deletes both for the owner's own unsynced draft.
              if (draftId) await api.post(`/transactions/${draftId}/cancel`).catch(() => undefined);
              navigate(-1);
            }}
            className="w-full sm:w-auto min-h-11 sm:min-h-0 rounded-lg border border-brand-200 px-4 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
