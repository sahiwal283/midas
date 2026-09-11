import { useState, useEffect, useRef, FormEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Upload, PencilLine, AlertCircle, AlertTriangle, CheckCircle2, Sparkles, ClipboardList } from 'lucide-react';
import { expenseApi, type DuplicateMatch } from '../api/expenses';
import { companyApi } from '../api/companies';
import { cardBelongsToCompany, cardsForCompany } from '../lib/paymentMethodScope';
import { CategoryPicker } from '../components/CategoryPicker';
import { EventPicker, useEventPickerAvailable } from '../components/EventPicker';
import { pathFromRoot } from '../lib/categoryTree';
import { useAuth } from '../contexts/AuthContext';
import { takePendingCapture } from '../lib/pendingCapture';
import { enqueueUpload, isLikelyOfflineOrNetworkError } from '../lib/uploadQueue';
import { VendorCombobox } from '../components/VendorCombobox';
import { ReceiptAttachments } from '../components/ReceiptAttachments';
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
  // A photo captured by the mobile nav's camera button before this form ever
  // rendered — handed to the strip so it uploads through the exact same path
  // as a user pick, rather than by a bare upload call here.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
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
  // itself (see MobileNav) and hands the photo over — consume it here.
  const consumedCapture = useRef(false);
  useEffect(() => {
    if (params.get('mode') !== 'scan' || consumedCapture.current) return;
    const captured = takePendingCapture();
    if (!captured) return;
    consumedCapture.current = true;
    setStep('form');
    // Handed to the strip below rather than uploaded here: same staging, same
    // ensureOwnerId, same hadNone/firstFired bookkeeping, same busy signal —
    // no upload happens outside the component.
    setPendingFile(captured);
  }, [params]);

  // Cards are company-specific; the ones this expense may actually be paid on.
  // A card prefilled from the user's defaults can belong to a different company
  // than their default entity, so the current selection is kept in the list
  // rather than disappearing out from under the select.
  const selectableCards = cardsForCompany(paymentMethods, form.company, form.paymentMethodId);
  const hiddenCardCount = paymentMethods.length - selectableCards.length;

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /** The strip needs an owner to attach to, so the draft is created here. */
  async function ensureExpenseId(): Promise<string> {
    if (expenseId) return expenseId;
    const expense = await expenseApi.create({ draft: true });
    setExpenseId(expense.id);
    return expense.id;
  }

  /**
   * `ReceiptAttachments` already retries an individual failed tile in place;
   * this only steps in for an offline/network failure, where the user is
   * likely to navigate away before connectivity returns. The whole failed
   * batch becomes one queue item — that is why `enqueueUpload` takes
   * `receipts` as an array.
   */
  function handleUploadFailed(files: File[], ownerId: string | null, err: unknown) {
    if (!isLikelyOfflineOrNetworkError(err)) return;
    void enqueueUpload({
      payload: {
        merchant: form.merchant,
        amount: Number(form.amount) || 0,
        date: form.date,
        currency: form.currency,
      },
      receipts: files,
      expenseId: ownerId ?? undefined,
      lastError: 'Receipt upload failed — queued for retry',
    }).then(() => {
      void qc.invalidateQueries({ queryKey: ['upload-queue-count'] });
      setError(
        files.length > 1
          ? 'You appear to be offline. The photos are queued and will retry automatically — you can keep filling out the form.'
          : 'You appear to be offline. The photo is queued and will retry automatically — you can keep filling out the form.',
      );
    });
  }

  function setCompany(name: string) {
    // Category is company-independent — never cleared when the company changes.
    // A card belonging to a different company is: paying a Boomin expense on a
    // Haute card files the payment against the wrong org's account in Zoho, so
    // the selection is dropped and the user picks again from this company's
    // cards. The merchant text stays — only its Zoho link is company-specific,
    // and the combobox re-matches it against the new company's vendors.
    setForm((f) => {
      const card = paymentMethods.find((p) => p.id === f.paymentMethodId);
      const keepCard = !card || cardBelongsToCompany(card, name);
      return { ...f, company: name, paymentMethodId: keepCard ? f.paymentMethodId : '' };
    });
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
                setPendingFile(null);
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
              onClick={() => setStep('form')}
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
              onClick={() => setStep('form')}
              className="flex w-full cursor-pointer items-center gap-4 rounded-xl border border-ink/10 bg-white p-5 text-left shadow-panel hover:border-brand-500/40"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-charcoal/70">
                <Upload className="h-6 w-6" />
              </span>
              <span>
                <span className="block font-semibold text-ink">Upload receipt</span>
                <span className="block text-sm text-charcoal/55">Add one or several — photos, HEIC or PDF</span>
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

        <div className="mt-4 rounded-xl border border-ink/10 bg-white p-4 shadow-panel">
          <h2 className="mb-3 text-sm font-semibold text-charcoal/80">Receipts</h2>
          {ocrRan && (
            <div className="mb-3">
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
          )}
          <ReceiptAttachments
            kind="expense"
            ownerId={expenseId}
            ensureOwnerId={ensureExpenseId}
            pendingFile={pendingFile}
            onFirstReceipt={applyOcr}
            onUploadFailed={handleUploadFailed}
            onBusyChange={setUploading}
          />
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4 rounded-xl border border-ink/10 bg-white p-5 shadow-panel">
          {/* Company leads the form, and the card and merchant follow it: both
              are company-specific in Zoho, so this is the answer that decides
              which cards and which vendors this expense may reference at all. */}
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

          <Field label="Payment method">
            <select
              value={form.paymentMethodId}
              onChange={(e) => setPaymentMethod(e.target.value)}
              disabled={!form.company}
              className={`${inputCls} disabled:bg-ink/[0.04] disabled:text-charcoal/40`}
            >
              <option value="">{form.company ? '— Select payment method —' : '— Pick a company first —'}</option>
              {selectableCards.map((pm) => (
                <option key={pm.id} value={pm.id}>
                  {pm.label}{pm.lastFour ? ` ···${pm.lastFour}` : ''}
                </option>
              ))}
            </select>
            {!form.company ? (
              <p className="mt-1 text-xs text-charcoal/50">Pick a company first — cards belong to one.</p>
            ) : hiddenCardCount > 0 ? (
              <p className="mt-1 text-xs text-charcoal/40">
                Showing {form.company} cards only ({hiddenCardCount} other {hiddenCardCount === 1 ? 'card' : 'cards'} hidden).
              </p>
            ) : null}
          </Field>

          <Field label="Merchant *">
            <VendorCombobox
              required
              disabled={!form.company}
              value={form.merchant}
              onChange={(m) => set('merchant', m)}
              zohoEntity={form.company || undefined}
              placeholder={form.company ? 'Coffee Shop, Airline, etc.' : 'Pick a company first'}
              inputClassName={`${inputCls} disabled:bg-ink/[0.04] disabled:text-charcoal/40${lowConfidenceFields.has('merchant') ? ' border-amber-400 ring-1 ring-amber-200' : ''}`}
            />
            {!form.company ? (
              <p className="mt-1 text-xs text-charcoal/50">Pick a company first — vendors belong to one.</p>
            ) : lowConfidenceFields.has('merchant') ? (
              <p className="mt-1 text-xs text-amber-700">OCR was unsure about the merchant — confirm or edit.</p>
            ) : null}
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
