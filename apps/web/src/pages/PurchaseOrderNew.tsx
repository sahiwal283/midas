import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api/client';
import { transactionReceiptApi } from '../api/expenses';
import { compressReceiptImage } from '../lib/receiptCompress';
import { LineItemReview, LOW_CONFIDENCE } from '../components/LineItemReview';
import { SearchableSelect } from '../components/SearchableSelect';
import { VendorCombobox } from '../components/VendorCombobox';
import { lineDraftsFromOcr, poHeaderFromOcr, type LineDraft } from '../lib/ocrLineItems';
import { takePendingCapture } from '../lib/pendingCapture';
import type { Transaction } from '@midas/shared';

type ZohoVendor = { vendorId: string; vendorName: string; companyName?: string | null };
type ZohoItem = { itemId: string; name: string; sku?: string | null; unit?: string | null };

// Shared so the OCR handoff can `ensureQueryData` the same cache entry the
// form renders from: OCR finishes while the catalogue may still be in flight,
// and matching against an empty catalogue would silently preselect nothing.
const itemsQueryOptions = {
  queryKey: ['zoho-items'],
  queryFn: async () => (await api.get<{ items: ZohoItem[] }>('/transactions/meta/items')).data.items,
  staleTime: 60_000,
  retry: 1,
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
  const vendorsQ = useQuery({
    queryKey: ['zoho-vendors'],
    queryFn: async () => (await api.get<{ vendors: ZohoVendor[] }>('/transactions/meta/vendors')).data.vendors,
    staleTime: 60_000,
    retry: 1,
  });
  const itemsQ = useQuery(itemsQueryOptions);

  const [vendorName, setVendorName] = useState('');
  const [zohoVendorId, setZohoVendorId] = useState('');
  const [transactionDate, setTransactionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [zohoEntity, setZohoEntity] = useState('');
  const [taxTotal, setTaxTotal] = useState('0');
  const [lines, setLines] = useState<LineDraft[]>([blankLine(1)]);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<File | null>(null);
  // The draft this photo belongs to. Held in state so a retaken photo reuses
  // the same purchase order instead of leaving an orphan behind.
  const [draftId, setDraftId] = useState<string | null>(null);
  const [ocrPhase, setOcrPhase] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');
  // The photo is on the draft already. False after a failed upload, so Save
  // retries it instead of quietly dropping the receipt.
  const [receiptAttached, setReceiptAttached] = useState(false);
  // The upload that is still on the wire, resolving to whether the file landed.
  // Save has to await this rather than read receiptAttached alone: taking the
  // "Enter manually instead" escape hatch does not stop the upload, so a user
  // who fills the form and saves before it resolves would otherwise upload the
  // same photo a second time — two receipts, two OCR jobs, two charges.
  const uploadInFlight = useRef<Promise<boolean> | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Set when the user takes the escape hatch: a late OCR response must not
  // overwrite what they have since typed.
  const abandonedOcr = useRef(false);
  // Identifies the newest scan, so a slower earlier one cannot land on top of it.
  const ocrRun = useRef(0);

  const items = itemsQ.data ?? [];
  const vendors = vendorsQ.data ?? [];

  const vendorOptions = useMemo(
    () => [...vendors].sort((a, b) => a.vendorName.localeCompare(b.vendorName)),
    [vendors],
  );
  const itemOptions = useMemo(
    () => [...items]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((it) => ({ value: it.itemId, label: it.name, hint: it.sku || it.itemId, unit: it.unit })),
    [items],
  );

  function pickVendor(id: string) {
    setZohoVendorId(id);
    const v = vendors.find((x) => x.vendorId === id);
    if (v) setVendorName(v.companyName || v.vendorName);
  }

  /**
   * A picked receipt starts the purchase order rather than waiting for Save:
   * the file needs an owner id to attach to, and OCR runs as part of that
   * upload. Everything OCR reads lands in the form for the user to confirm.
   */
  async function startWithReceipt(file: File) {
    const run = ocrRun.current + 1;
    ocrRun.current = run;
    abandonedOcr.current = false;
    const superseded = () => abandonedOcr.current || ocrRun.current !== run;
    setError(null);
    setReceipt(file);
    setReceiptAttached(false);
    setOcrPhase('working');
    // Tracked locally as well as in state: the catch below runs before React has
    // re-rendered, so the state value there would still read false.
    let attached = false;
    try {
      let id = draftId;
      if (!id) {
        const { data } = await api.post<{ transaction: Transaction }>('/transactions/purchase-orders', {
          vendorName: '',
          transactionDate,
          lineItems: [],
        });
        id = data.transaction.id;
        setDraftId(id);
      }
      const draft = id;
      // This file is on the draft whatever happens to the OCR result below, so
      // record it even when the user has abandoned OCR — Save must not upload it
      // a second time. But only for the newest scan: a slower earlier upload
      // must not vouch for a photo the user has since replaced, or Save would
      // skip the replacement and silently drop it.
      const upload = (async () => {
        const res = await transactionReceiptApi.upload(draft, await compressReceiptImage(file));
        if (ocrRun.current === run) {
          attached = true;
          setReceiptAttached(true);
        }
        return res;
      })();
      // Never rejects: Save reads it as "did the file land", and a false sends
      // Save down its own retry path rather than throwing there.
      uploadInFlight.current = upload.then(() => ocrRun.current === run, () => false);
      const { receipt: uploaded } = await upload;
      if (superseded()) return;

      const header = poHeaderFromOcr(uploaded.ocrData);
      if (header.vendorName) setVendorName(header.vendorName);
      if (header.transactionDate) setTransactionDate(header.transactionDate);
      if (header.taxTotal) setTaxTotal(header.taxTotal);
      // The catalogue drives item matching, so wait for it rather than matching
      // against whatever happened to be cached when the upload started. A
      // catalogue that will not load is not worth failing the scan over.
      const catalogue = await queryClient.ensureQueryData(itemsQueryOptions).catch(() => [] as ZohoItem[]);
      if (superseded()) return;
      const drafts = lineDraftsFromOcr(uploaded.ocrData, catalogue);
      if (drafts.length) setLines(drafts);
      setOcrPhase('done');
    } catch (err) {
      if (superseded()) return;
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      // Only promise the photo is saved when it actually is. When the upload
      // itself is what failed this banner would otherwise contradict the status
      // card two elements away, which says it will be attached on save.
      setError(msg || (attached
        ? 'The receipt could not be read. Enter the details by hand — the photo is saved.'
        : 'The receipt could not be read. Enter the details by hand — the photo will be attached when you save.'));
      setOcrPhase('failed');
    }
  }

  // ?mode=scan: the mobile nav takes the photo inside the tap gesture (a
  // programmatic click after navigation is blocked on mobile) and hands it over.
  const consumedCapture = useRef(false);
  useEffect(() => {
    if (params.get('mode') !== 'scan' || consumedCapture.current) return;
    const captured = takePendingCapture();
    if (captured) {
      consumedCapture.current = true;
      void startWithReceipt(captured);
    }
  }, [params]);

  useEffect(() => {
    if (receipt && receipt.type.startsWith('image/')) {
      const url = URL.createObjectURL(receipt);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setPreviewUrl(null);
  }, [receipt]);

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
      if (!receipt) return { tx, receiptError: null };
      // The photo uploads as soon as it is picked. If that upload has not
      // settled yet, wait for it — starting a second upload of the same file
      // would attach it twice and bill a second OCR job.
      const alreadyAttached = receiptAttached
        || (uploadInFlight.current ? await uploadInFlight.current : false);
      if (alreadyAttached) return { tx, receiptError: null };

      // The purchase order now exists, so a failed upload must not fail the
      // save — losing a filled-in PO to a network blip is far worse than
      // landing on it with the receipt still missing. Carry the reason to the
      // detail page instead, where the Upload button is waiting.
      try {
        await transactionReceiptApi.upload(tx.id, await compressReceiptImage(receipt));
        return { tx, receiptError: null };
      } catch (err) {
        const msg = (err as { response?: { data?: { error?: { message?: string } } } })
          ?.response?.data?.error?.message;
        return { tx, receiptError: msg || 'The receipt could not be uploaded.' };
      }
    },
    onSuccess: ({ tx, receiptError }) =>
      navigate(`/transactions/${tx.id}`, { state: receiptError ? { receiptUploadFailed: receiptError } : undefined }),
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
      {(vendorsQ.isError || itemsQ.isError) && (
        <p className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Could not load Zoho vendors/items. You can still draft the PO and map IDs later — push will require them.
        </p>
      )}

      {ocrPhase !== 'idle' && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-ink/10 bg-white p-4 shadow-panel">
          {previewUrl && (
            <img src={previewUrl} alt="Receipt" className="h-20 w-20 shrink-0 rounded-md border border-ink/10 object-cover" />
          )}
          <div className="min-w-0 flex-1">
            {ocrPhase === 'working' ? (
              <>
                <p className="flex items-center gap-2 text-sm text-charcoal/70">
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                  Reading the receipt…
                </p>
                <button
                  type="button"
                  onClick={() => { abandonedOcr.current = true; setOcrPhase('idle'); }}
                  className="mt-2 min-h-11 text-sm font-medium text-brand-700"
                >
                  Enter manually instead
                </button>
              </>
            ) : (
              <p className="text-sm text-charcoal/70">
                {ocrPhase === 'done' && 'Receipt attached. Check the lines below before saving.'}
                {ocrPhase !== 'done' && (receiptAttached
                  ? 'Receipt attached.'
                  : 'The photo will be attached when you save.')}
              </p>
            )}
          </div>
        </div>
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
            inputClassName="w-full rounded border border-brand-200 px-3 py-3 lg:py-2 text-sm"
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
            className="mt-1 w-full rounded border border-brand-200 px-3 py-3 lg:py-2"
            value={transactionDate}
            onChange={(e) => setTransactionDate(e.target.value)}
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-charcoal/80">Company *</span>
          <select
            required
            className="mt-1 w-full rounded border border-brand-200 px-3 py-3 lg:py-2"
            value={zohoEntity}
            onChange={(e) => setZohoEntity(e.target.value)}
          >
            <option value="">Select a company…</option>
            {(companies.data ?? []).map((c: { name: string }) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-charcoal/80">Receipt</span>
          <input
            type="file"
            accept="image/*,.pdf,.heic,.heif"
            className="mt-1 w-full rounded border border-brand-200 px-3 py-3 text-sm file:mr-3 file:rounded file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:text-brand-700 lg:py-2"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void startWithReceipt(file);
            }}
          />
          <span className="mt-1 block text-xs text-charcoal/50">
            {receipt
              ? `${receipt.name} — ${receiptAttached ? 'attached to this draft.' : 'uploads when you save.'}`
              : 'Attached as soon as you pick it, and read for vendor and line items.'}
          </span>
        </label>
      </div>

      <h2 className="text-sm font-semibold text-ink mb-2">Line items</h2>

      <LineItemReview
        lines={lines}
        onChange={setLines}
        itemOptions={itemOptions}
        itemsLoading={itemsQ.isLoading}
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
