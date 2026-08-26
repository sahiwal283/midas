import { useState, useEffect, useRef, FormEvent, ChangeEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Upload, PencilLine, X, FileText, AlertCircle, AlertTriangle, CheckCircle2, Sparkles, ClipboardList } from 'lucide-react';
import { expenseApi, type DuplicateMatch } from '../api/expenses';
import { companyApi } from '../api/companies';
import { CategoryPicker } from '../components/CategoryPicker';
import { EventPicker, useEventPickerAvailable } from '../components/EventPicker';
import { pathFromRoot } from '../lib/categoryTree';
import { useAuth } from '../contexts/AuthContext';
import { enqueueUpload, isLikelyOfflineOrNetworkError } from '../lib/uploadQueue';
import { compressReceiptImage } from '../lib/receiptCompress';
import { takePendingCapture } from '../lib/pendingCapture';
import { VendorCombobox } from '../components/VendorCombobox';
import { pickReferenceNumber } from '@midas/shared';
import type { Receipt } from '../types';

type WizardStep = 'choose' | 'form' | 'done';

const inputCls = 'w-full rounded-lg border border-ink/15 bg-white px-3 py-3 lg:py-2 text-sm text-ink placeholder:text-charcoal/40 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

function StepHint({ current, total, label }: { current: number; total: number; label: string }) {
  return (
    <p className="mt-1 text-xs font-medium uppercase tracking-[0.12em] text-charcoal/40">
      Step {current} of {total} · {label}
    </p>
  );
}

export function ExpenseNew() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();

  const [step, setStep] = useState<WizardStep>('choose');
  const [expenseId, setExpenseId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [ocrRan, setOcrRan] = useState(false);
  // OCR-suggested expense category (raw string from the receipt scan).
  const [ocrCategorySuggestion, setOcrCategorySuggestion] = useState<string | null>(null);
  // True when the current category selection came from the OCR suggestion.
  const [categoryAutoSuggested, setCategoryAutoSuggested] = useState(false);
  /** Field keys with OCR confidence below 0.7 — shown as amber warnings on the form. */
  const [lowConfidenceFields, setLowConfidenceFields] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null);
  // The picker renders nothing when the trade show link is off, so the Event
  // field must not render its label either.
  const eventsAvailable = useEventPickerAvailable();
  const [result, setResult] = useState<{
    autoPushed: boolean;
    pending: boolean;
    missing: string[] | null;
    expenseId: string | null;
  } | null>(null);

  const [form, setForm] = useState({
    merchant: '',
    amount: '',
    date: new Date().toISOString().slice(0, 10),
    currency: 'USD',
    paymentMethodId: '',
    company: '',
    categoryId: '',
    description: '',
    referenceNumber: '',
    eventId: '',
    expenseKind: 'business' as 'business' | 'partner',
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const { user } = useAuth();
  const defaultsApplied = useRef(false);

  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => companyApi.list(),
  });
  const { data: paymentMethods = [], isFetched: paymentMethodsFetched } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => expenseApi.paymentMethods(),
  });

  // Prefill company / payment method from the user's admin-configured defaults.
  // Runs once; never overwrites values the user (or a picked card) already set.
  useEffect(() => {
    if (defaultsApplied.current || !user) return;
    if (!user.defaultZohoEntity && !user.defaultPaymentMethodId) return;
    // Wait for the payment methods list when a default card is set, so we can
    // resolve its entity and confirm the card is still selectable.
    if (user.defaultPaymentMethodId && !paymentMethodsFetched) return;
    defaultsApplied.current = true;
    const pm = paymentMethods.find((p) => p.id === user.defaultPaymentMethodId);
    setForm((f) => {
      if (f.paymentMethodId || f.company) return f;
      const company = user.defaultZohoEntity || pm?.defaultZohoEntity || '';
      return { ...f, paymentMethodId: pm?.id ?? '', company };
    });
  }, [user, paymentMethods, paymentMethodsFetched]);

  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => expenseApi.categories(),
    staleTime: 60_000,
  });

  // ?mode=scan: the mobile camera button opens the native camera in the nav
  // itself (see MobileNav) and hands the photo over — consume it here. The
  // programmatic-click fallback covers direct visits to this URL.
  const consumedCapture = useRef(false);
  useEffect(() => {
    if (params.get('mode') !== 'scan') return;
    const captured = takePendingCapture();
    if (captured) {
      consumedCapture.current = true;
      void startWithReceipt(captured);
      return;
    }
    if (consumedCapture.current) return;
    const t = setTimeout(() => cameraInputRef.current?.click(), 150);
    return () => clearTimeout(t);
  }, [params]);

  useEffect(() => {
    if (receipt && receipt.type.startsWith('image/')) {
      const url = URL.createObjectURL(receipt);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setPreviewUrl(null);
  }, [receipt]);

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setCompany(name: string) {
    // Category is company-independent — never cleared when the company changes.
    setForm((f) => ({ ...f, company: name }));
  }

  function setPaymentMethod(pmId: string) {
    const pm = paymentMethods.find((p) => p.id === pmId);
    setForm((f) => ({
      ...f,
      paymentMethodId: pmId,
      company: f.company || pm?.defaultZohoEntity || '',
    }));
  }

  function applyOcr(r: Receipt) {
    // Upload succeeded but OCR itself failed — the receipt is safely attached;
    // tell the user to type the details instead of pretending we read them.
    if (r.ocrStatus === 'failed') {
      setOcrRan(false);
      setError('Receipt attached, but we could not read it automatically. Please fill in the details below.');
      return;
    }
    const fields = r.ocrData?.fields;
    setOcrRan(true);
    setOcrCategorySuggestion(fields?.category?.value ?? null);
    const low = new Set<string>();
    const confThreshold = 0.7;
    for (const key of ['merchant', 'amount', 'date', 'referenceNumber'] as const) {
      const conf = fields?.[key]?.confidence;
      if (typeof conf === 'number' && conf < confThreshold) low.add(key);
    }
    if (r.ocrNeedsReview) {
      low.add('merchant');
      low.add('amount');
      low.add('date');
    }
    setLowConfidenceFields(low);
    setForm((f) => {
      const nextRef = f.referenceNumber.trim()
        ? f.referenceNumber
        : (pickReferenceNumber({
          field: fields?.referenceNumber?.value,
          text: r.ocrText,
        }) ?? f.referenceNumber);
      return {
        ...f,
        merchant: fields?.merchant?.value ?? f.merchant,
        amount: fields?.amount?.value != null ? String(fields.amount.value) : f.amount,
        date: fields?.date?.value ?? f.date,
        referenceNumber: nextRef,
      };
    });
  }

  // Preselect the Midas category matching the OCR suggestion — never overriding
  // a non-empty user pick. Deepest (most specific) name match wins.
  useEffect(() => {
    if (!ocrCategorySuggestion || form.categoryId) return;
    const sugg = ocrCategorySuggestion.trim().toLowerCase();
    if (!sugg || categories.length === 0) return;
    const matches = categories.filter((c) => {
      const name = c.name.toLowerCase();
      return name.includes(sugg) || sugg.includes(name);
    });
    if (matches.length === 0) return;
    const deepest = matches.reduce((a, b) => (
      pathFromRoot(categories, b.id).length > pathFromRoot(categories, a.id).length ? b : a
    ));
    setForm((f) => (f.categoryId ? f : { ...f, categoryId: deepest.id }));
    setCategoryAutoSuggested(true);
  }, [ocrCategorySuggestion, categories, form.categoryId]);

  /** Photo/upload entry: create empty draft, upload receipt, let OCR prefill. */
  async function startWithReceipt(original: File) {
    setError('');
    // Shrink multi-MB camera photos before they hit the network — the single
    // biggest lever for upload speed on mobile data.
    const file = await compressReceiptImage(original);
    setReceipt(file);
    setStep('form');
    setUploading(true);
    try {
      let id = expenseId;
      if (!id) {
        const expense = await expenseApi.create({ draft: true });
        id = expense.id;
        setExpenseId(id);
      }
      const uploaded = await expenseApi.uploadReceipt(id, file);
      applyOcr(uploaded);
    } catch (err) {
      if (isLikelyOfflineOrNetworkError(err)) {
        await enqueueUpload({
          payload: { merchant: form.merchant, amount: Number(form.amount) || 0, date: form.date, currency: form.currency },
          receipt: file,
          expenseId: expenseId ?? undefined,
          lastError: 'Receipt upload failed — queued for retry',
        });
        void qc.invalidateQueries({ queryKey: ['upload-queue-count'] });
        setError('You appear to be offline. The receipt is queued and will retry automatically — you can keep filling out the form.');
      } else {
        // The upload itself failed — the server has no receipt. Clear the local
        // file so the form doesn't claim "Receipt attached" when nothing is.
        setReceipt(null);
        setError(
          err && typeof err === 'object' && (err as any)?.response?.status === 413
            ? 'That photo is too large to upload (max 10 MB). Please retake it or choose a smaller image.'
            : 'We could not upload the receipt. You can fill in the details manually and try attaching it again.',
        );
        setOcrRan(false);
      }
    } finally {
      setUploading(false);
    }
  }

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void startWithReceipt(file);
    e.target.value = '';
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!form.merchant.trim() || !form.amount || Number(form.amount) <= 0) {
      setError('Merchant and a valid amount are required.');
      return;
    }
    // One duplicate pre-check per submit attempt. A network failure here must
    // never block submission — proceed silently.
    try {
      const { duplicate: match } = await expenseApi.checkDuplicate({
        merchant: form.merchant.trim(),
        amount: Number(form.amount),
        date: form.date,
      });
      if (match) {
        setDuplicate(match);
        return;
      }
    } catch {
      // Duplicate check is best-effort only.
    }
    await doSubmit();
  }

  /** The actual submit flow — "Submit anyway" calls this directly, skipping the re-check. */
  async function doSubmit() {
    setDuplicate(null);
    setSubmitting(true);
    try {
      const payload = {
        merchant: form.merchant.trim(),
        amount: Number(form.amount),
        date: form.date,
        currency: form.currency,
        paymentMethodId: form.paymentMethodId || undefined,
        zohoEntity: form.company || undefined,
        categoryId: form.categoryId || undefined,
        description: form.description || undefined,
        referenceNumber: form.referenceNumber.trim() || undefined,
        eventId: form.eventId || null,
        expenseKind: form.expenseKind,
      };

      let id = expenseId;
      if (!id) {
        const expense = await expenseApi.create({ ...payload });
        id = expense.id;
        setExpenseId(id);
      } else {
        await expenseApi.update(id, payload);
      }

      const submitted = await expenseApi.submit(id);
      qc.invalidateQueries({ queryKey: ['expenses'] });
      setResult({
        autoPushed: !!submitted.autoPushed,
        pending: submitted.expense.status === 'pending',
        missing: submitted.missing ?? null,
        expenseId: id,
      });
      setStep('done');
    } catch (err: any) {
      const code = err?.response?.data?.error?.code;
      const message = err?.response?.data?.error?.message;
      // Codes whose server message says something the user can act on — a
      // closed month, an event deleted in Argo since the picker loaded
      // (UNKNOWN_EVENT), a trade show link that is down (EVENTS_UNAVAILABLE).
      // Anything else stays the generic fallback.
      const serverExplains = ['PERIOD_CLOSED', 'UNKNOWN_EVENT', 'EVENTS_UNAVAILABLE'];
      setError(
        code === 'INCOMPLETE_DRAFT'
          ? 'Merchant and amount are required before submitting.'
          : serverExplains.includes(code) && message
            ? message
            : 'Could not submit the expense. Please check the fields and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ── Step: done ───────────────────────────────────────────────────────────
  if (step === 'done' && result) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-4 lg:p-8">
        <div className="w-full max-w-md rounded-2xl border border-ink/10 bg-white p-8 text-center shadow-panel">
          <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
          <StepHint current={3} total={3} label="Done" />
          <h1 className="mt-3 font-display text-2xl font-semibold text-ink">
            {result.pending
              ? (result.missing?.length ? 'Submitted — a few details missing' : 'Submitted for review')
              : 'Approved'}
          </h1>
          <p className="mt-2 text-sm text-charcoal/55">
            {result.pending
              ? result.missing?.length
                ? `Add the missing ${result.missing.join(', ')} and this expense will be approved automatically — no accountant review needed.`
                : 'Your expense was submitted. The accountant will review it shortly.'
              : result.autoPushed
                ? 'Your expense was approved and sent to accounting.'
                : 'Your expense was approved.'}
          </p>
          {result.pending && !!result.missing?.length && result.expenseId && (
            <Link
              to={`/expenses/${result.expenseId}`}
              className="mt-3 inline-block text-sm font-medium text-brand-700 hover:underline"
            >
              Complete it now →
            </Link>
          )}
          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => {
                setStep('choose');
                setExpenseId(null);
                setReceipt(null);
                setOcrRan(false);
                setOcrCategorySuggestion(null);
                setCategoryAutoSuggested(false);
                setResult(null);
                setForm((f) => ({ ...f, merchant: '', amount: '', description: '', categoryId: '' }));
              }}
              className="rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-semibold text-cream hover:bg-brand-600"
            >
              Add another
            </button>
            <Link
              to="/expenses"
              className="rounded-lg border border-ink/15 px-5 py-2.5 text-sm font-medium text-ink hover:bg-ink/[0.03]"
            >
              My Expenses
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── Step: choose ─────────────────────────────────────────────────────────
  if (step === 'choose') {
    return (
      <div className="p-4 lg:p-8">
        <div className="mx-auto max-w-xl">
          <h1 className="font-display text-3xl font-semibold text-ink">Add Transaction</h1>
          <StepHint current={1} total={3} label="Choose how to start" />
          <p className="mt-2 text-sm text-charcoal/55">
            A receipt expense, or a purchase order with vendor line items.
          </p>

          <div className="mt-6 space-y-3">
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              className="flex w-full cursor-pointer items-center gap-4 rounded-xl border-2 border-brand-500/30 bg-brand-500/10 p-5 text-left hover:border-brand-500"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-500 text-cream">
                <Camera className="h-6 w-6" />
              </span>
              <span>
                <span className="block font-semibold text-ink">Scan receipt</span>
                <span className="block text-sm text-charcoal/55">Take a photo with your camera</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full cursor-pointer items-center gap-4 rounded-xl border border-ink/10 bg-white p-5 text-left shadow-panel hover:border-brand-500/40"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-charcoal/70">
                <Upload className="h-6 w-6" />
              </span>
              <span>
                <span className="block font-semibold text-ink">Upload receipt</span>
                <span className="block text-sm text-charcoal/55">From your camera roll or files (photos, HEIC, PDF)</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => setStep('form')}
              className="flex w-full cursor-pointer items-center gap-4 rounded-xl border border-ink/10 bg-white p-5 text-left shadow-panel hover:border-brand-500/40"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-charcoal/70">
                <PencilLine className="h-6 w-6" />
              </span>
              <span>
                <span className="block font-semibold text-ink">Enter manually</span>
                <span className="block text-sm text-charcoal/55">Type the details, attach the receipt later</span>
              </span>
            </button>

            <Link
              to="/transactions/po/new"
              className="flex w-full cursor-pointer items-center gap-4 rounded-xl border border-ink/10 bg-white p-5 text-left shadow-panel hover:border-brand-500/40"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-charcoal/70">
                <ClipboardList className="h-6 w-6" />
              </span>
              <span>
                <span className="block font-semibold text-ink">Purchase order</span>
                <span className="block text-sm text-charcoal/55">Vendor order with line items — attach the receipt too</span>
              </span>
            </Link>
          </div>

          <input ref={fileInputRef} type="file" accept="image/*,.pdf,.heic,.heif" className="hidden" onChange={handleFile} />
          <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFile} />
        </div>
      </div>
    );
  }

  // ── Step: form ───────────────────────────────────────────────────────────
  return (
    <div className="p-4 pb-28 lg:p-8">
      <div className="mx-auto max-w-xl">
        <h1 className="font-display text-3xl font-semibold text-ink">Add Expense</h1>
        <StepHint current={2} total={3} label={ocrRan ? 'Review & submit' : 'Enter details'} />

        {/* Receipt summary / OCR review card */}
        {receipt && (
          <div className="mt-4 rounded-xl border border-ink/10 bg-white p-4 shadow-panel">
            <div className="flex items-start gap-3">
              {previewUrl ? (
                <img src={previewUrl} alt="Receipt" className="h-20 w-20 shrink-0 rounded-md border border-ink/10 object-cover" />
              ) : (
                <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md border border-ink/10 bg-cream">
                  <FileText className="h-8 w-8 text-charcoal/40" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                {uploading ? (
                  <p className="flex items-center gap-2 text-sm text-charcoal/70">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                    Reading your receipt…
                  </p>
                ) : ocrRan ? (
                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                      <Sparkles className="h-4 w-4 text-brand-600" />
                      Check what we read — correct anything that looks off.
                    </p>
                    {lowConfidenceFields.size > 0 && (
                      <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-800">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        Low confidence on {Array.from(lowConfidenceFields).join(', ')} — please double-check those fields.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-charcoal/60">Receipt attached.</p>
                )}
                <p className="mt-1 truncate text-xs text-charcoal/40">{receipt.name}</p>
                <button
                  type="button"
                  onClick={() => {
                    setReceipt(null);
                    setOcrRan(false);
                    setOcrCategorySuggestion(null);
                    setLowConfidenceFields(new Set());
                  }}
                  className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-charcoal/50 hover:text-danger"
                >
                  <X className="h-3 w-3" /> Remove
                </button>
              </div>
            </div>
          </div>
        )}

        {!receipt && (
          <div className="mt-4 flex items-center justify-between rounded-xl border border-dashed border-ink/20 bg-white/60 px-4 py-3">
            <p className="text-sm text-charcoal/50">No receipt attached yet.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => cameraInputRef.current?.click()} className="rounded-lg border border-ink/15 bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-ink/[0.03]">
                Scan
              </button>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="rounded-lg border border-ink/15 bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-ink/[0.03]">
                Upload
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4 rounded-xl border border-ink/10 bg-white p-5 shadow-panel">
          <Field label="Merchant *">
            <VendorCombobox
              required
              value={form.merchant}
              onChange={(m) => set('merchant', m)}
              zohoEntity={form.company || undefined}
              inputClassName={`${inputCls}${lowConfidenceFields.has('merchant') ? ' border-amber-400 ring-1 ring-amber-200' : ''}`}
            />
            {lowConfidenceFields.has('merchant') && (
              <p className="mt-1 text-xs text-amber-700">OCR was unsure about the merchant — confirm or edit.</p>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount *">
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                placeholder="0.00"
                className={`${inputCls}${lowConfidenceFields.has('amount') ? ' border-amber-400 ring-1 ring-amber-200' : ''}`}
              />
              {lowConfidenceFields.has('amount') && (
                <p className="mt-1 text-xs text-amber-700">Double-check the amount.</p>
              )}
            </Field>
            <Field label="Date *">
              <input
                required
                type="date"
                value={form.date}
                onChange={(e) => set('date', e.target.value)}
                className={`${inputCls}${lowConfidenceFields.has('date') ? ' border-amber-400 ring-1 ring-amber-200' : ''}`}
              />
              {lowConfidenceFields.has('date') && (
                <p className="mt-1 text-xs text-amber-700">Double-check the date.</p>
              )}
            </Field>
          </div>

          <Field label="Payment method">
            <select value={form.paymentMethodId} onChange={(e) => setPaymentMethod(e.target.value)} className={inputCls}>
              <option value="">— Select payment method —</option>
              {paymentMethods.map((pm) => (
                <option key={pm.id} value={pm.id}>
                  {pm.label}{pm.lastFour ? ` ···${pm.lastFour}` : ''}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Company">
            <select value={form.company} onChange={(e) => setCompany(e.target.value)} className={inputCls}>
              <option value="">— Select company —</option>
              {companies.map((c) => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
            {form.paymentMethodId && form.company && (
              <p className="mt-1 text-xs text-charcoal/40">Auto-filled from your card — change it if this expense belongs to another company.</p>
            )}
          </Field>

          <Field label="Category">
            <CategoryPicker
              categories={categories}
              value={form.categoryId}
              onChange={(id) => { setCategoryAutoSuggested(false); set('categoryId', id); }}
              inputClassName={inputCls}
            />
            {categoryAutoSuggested && !!form.categoryId && (
              <p className="mt-1 text-xs text-charcoal/40">Suggested from the receipt — change if wrong.</p>
            )}
          </Field>

          {eventsAvailable && (
            <Field label="Event">
              <EventPicker
                value={form.eventId}
                onChange={(id) => set('eventId', id)}
                className={inputCls}
              />
            </Field>
          )}

          {(user?.role === 'partner' || user?.role === 'developer') && (
            <Field label="Expense type">
              <div className="flex gap-2">
                {(['business', 'partner'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => set('expenseKind', kind)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      form.expenseKind === kind
                        ? 'border-brand-500 bg-brand-500/10 text-ink'
                        : 'border-ink/15 text-charcoal/60 hover:bg-ink/[0.03]'
                    }`}
                  >
                    {kind === 'business' ? 'Business expense' : 'Partner expense'}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-charcoal/40">
                Partner expenses are tracked on the Partner Expenses tab and are not sent to accounting.
              </p>
            </Field>
          )}

          <Field label="Reference number (optional)">
            <input
              type="text"
              maxLength={50}
              value={form.referenceNumber}
              onChange={(e) => set('referenceNumber', e.target.value)}
              placeholder="Receipt #, invoice #, sales order…"
              className={`${inputCls}${lowConfidenceFields.has('referenceNumber') ? ' border-amber-400 ring-1 ring-amber-200' : ''}`}
            />
            {lowConfidenceFields.has('referenceNumber') ? (
              <p className="mt-1 text-xs text-amber-700">Double-check the receipt or invoice number.</p>
            ) : (
              <p className="mt-1 text-xs text-charcoal/40">Sent to Zoho as Reference Number when this expense is pushed.</p>
            )}
          </Field>

          <Field label="Notes (optional)">
            <textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={2} placeholder="Anything the accountant should know" className={`${inputCls} resize-none`} />
          </Field>

          {duplicate && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0 text-sm">
                  <p className="font-semibold text-amber-900">
                    Possible duplicate — {duplicate.merchant} · ${Number(duplicate.amount).toFixed(2)} · {duplicate.date} ({duplicate.status})
                  </p>
                  <p className="mt-0.5 text-amber-800">A similar expense was already submitted.</p>
                </div>
              </div>
              <div className="mt-2.5 flex gap-2 pl-6">
                <button
                  type="button"
                  onClick={() => void doSubmit()}
                  disabled={submitting}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-cream hover:bg-amber-700 disabled:opacity-60"
                >
                  Submit anyway
                </button>
                <button
                  type="button"
                  onClick={() => setDuplicate(null)}
                  className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                >
                  Go back
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={submitting || uploading}
              className="flex-1 rounded-lg bg-brand-500 px-5 py-3 text-sm font-semibold text-cream hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60 lg:flex-none"
            >
              {submitting ? 'Submitting…' : 'Submit expense'}
            </button>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="rounded-lg border border-ink/15 px-5 py-3 text-sm font-medium text-ink hover:bg-ink/[0.03]"
            >
              Cancel
            </button>
          </div>
        </form>

        <input ref={fileInputRef} type="file" accept="image/*,.pdf,.heic,.heif" className="hidden" onChange={handleFile} />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFile} />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-charcoal/70">{label}</label>
      {children}
    </div>
  );
}
