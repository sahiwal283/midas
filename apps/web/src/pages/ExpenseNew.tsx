import { useState, useEffect, useRef, FormEvent, ChangeEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Upload, PencilLine, X, FileText, AlertCircle, AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react';
import { expenseApi, type DuplicateMatch } from '../api/expenses';
import { companyApi } from '../api/companies';
import { useAuth } from '../contexts/AuthContext';
import { enqueueUpload, isLikelyOfflineOrNetworkError } from '../lib/uploadQueue';
import type { Receipt } from '../types';

type WizardStep = 'choose' | 'form' | 'done';

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-3 lg:py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

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
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null);
  const [result, setResult] = useState<{ autoPushed: boolean; pending: boolean } | null>(null);

  const [form, setForm] = useState({
    merchant: '',
    amount: '',
    date: new Date().toISOString().slice(0, 10),
    currency: 'USD',
    paymentMethodId: '',
    company: '',
    zohoExpenseAccountId: '',
    zohoExpenseAccountName: '',
    description: '',
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

  const selectedCompany = companies.find((c) => c.name === form.company);
  const zohoOn = selectedCompany ? selectedCompany.zohoEnabled : true;

  const { data: accountData, isFetching: accountsLoading } = useQuery({
    queryKey: ['zoho-expense-accounts', form.company],
    queryFn: () => expenseApi.zohoExpenseAccounts(form.company),
    enabled: !!form.company && zohoOn,
    staleTime: 60_000,
    retry: 1,
  });
  const expenseAccounts = accountData?.accounts ?? [];

  // ?mode=scan (mobile camera button) jumps straight into the camera.
  useEffect(() => {
    if (params.get('mode') === 'scan') {
      const t = setTimeout(() => cameraInputRef.current?.click(), 150);
      return () => clearTimeout(t);
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

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setCompany(name: string) {
    setForm((f) => ({ ...f, company: name, zohoExpenseAccountId: '', zohoExpenseAccountName: '' }));
  }

  function setPaymentMethod(pmId: string) {
    const pm = paymentMethods.find((p) => p.id === pmId);
    setForm((f) => {
      const nextCompany = f.company || pm?.defaultZohoEntity || '';
      const changed = nextCompany !== f.company;
      return {
        ...f,
        paymentMethodId: pmId,
        company: nextCompany,
        ...(changed ? { zohoExpenseAccountId: '', zohoExpenseAccountName: '' } : {}),
      };
    });
  }

  function applyOcr(r: Receipt) {
    const fields = r.ocrData?.fields;
    setOcrRan(true);
    setOcrCategorySuggestion(fields?.category?.value ?? null);
    setForm((f) => ({
      ...f,
      merchant: fields?.merchant?.value ?? f.merchant,
      amount: fields?.amount?.value != null ? String(fields.amount.value) : f.amount,
      date: fields?.date?.value ?? f.date,
    }));
  }

  // Preselect the COA account matching the OCR category suggestion once the
  // company's account list loads — never overriding a non-empty user pick.
  // Re-applies if the user switches company (which clears the selection).
  useEffect(() => {
    if (!ocrCategorySuggestion || form.zohoExpenseAccountId) return;
    const accounts = accountData?.accounts ?? [];
    const sugg = ocrCategorySuggestion.trim().toLowerCase();
    if (!sugg || accounts.length === 0) return;
    const match = accounts.find((a) => {
      const name = a.accountName.toLowerCase();
      return name.includes(sugg) || sugg.includes(name);
    });
    if (!match) return;
    setForm((f) => (f.zohoExpenseAccountId
      ? f
      : { ...f, zohoExpenseAccountId: match.accountId, zohoExpenseAccountName: match.accountName }));
    setCategoryAutoSuggested(true);
  }, [ocrCategorySuggestion, accountData, form.zohoExpenseAccountId]);

  /** Photo/upload entry: create empty draft, upload receipt, let OCR prefill. */
  async function startWithReceipt(file: File) {
    setError('');
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
        setError('We could not read the receipt automatically. You can fill in the details manually below.');
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
        zohoExpenseAccountId: (zohoOn && form.zohoExpenseAccountId) || undefined,
        zohoExpenseAccountName: (zohoOn && form.zohoExpenseAccountName) || undefined,
        description: form.description || undefined,
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
      });
      setStep('done');
    } catch (err: any) {
      const code = err?.response?.data?.error?.code;
      setError(
        code === 'INCOMPLETE_DRAFT'
          ? 'Merchant and amount are required before submitting.'
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
        <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-green-500" />
          <h1 className="mt-4 text-xl font-bold text-gray-900">
            {result.pending ? 'Submitted for review' : 'Approved ✓'}
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            {result.pending
              ? 'Your expense was submitted. The accountant will review it shortly.'
              : result.autoPushed
                ? 'Your expense was approved and sent to accounting.'
                : 'Your expense was approved.'}
          </p>
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
                setForm((f) => ({ ...f, merchant: '', amount: '', description: '', zohoExpenseAccountId: '', zohoExpenseAccountName: '' }));
              }}
              className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Add another
            </button>
            <Link
              to="/expenses"
              className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
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
          <h1 className="text-2xl font-bold text-gray-900">Add Expense</h1>
          <p className="mt-1 text-sm text-gray-500">Start with the receipt — we'll read it for you.</p>

          <div className="mt-6 space-y-3">
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              className="flex w-full items-center gap-4 rounded-xl border-2 border-brand-200 bg-brand-50 p-5 text-left hover:border-brand-400"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white">
                <Camera className="h-6 w-6" />
              </span>
              <span>
                <span className="block font-semibold text-gray-900">Scan receipt</span>
                <span className="block text-sm text-gray-500">Take a photo with your camera</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center gap-4 rounded-xl border border-gray-200 bg-white p-5 text-left hover:border-brand-300"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
                <Upload className="h-6 w-6" />
              </span>
              <span>
                <span className="block font-semibold text-gray-900">Upload receipt</span>
                <span className="block text-sm text-gray-500">From your camera roll or files (photos, HEIC, PDF)</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => setStep('form')}
              className="flex w-full items-center gap-4 rounded-xl border border-gray-200 bg-white p-5 text-left hover:border-brand-300"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
                <PencilLine className="h-6 w-6" />
              </span>
              <span>
                <span className="block font-semibold text-gray-900">Enter manually</span>
                <span className="block text-sm text-gray-500">Type the details, attach the receipt later</span>
              </span>
            </button>
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
        <h1 className="text-2xl font-bold text-gray-900">Add Expense</h1>

        {/* Receipt summary / OCR review card */}
        {receipt && (
          <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-start gap-3">
              {previewUrl ? (
                <img src={previewUrl} alt="Receipt" className="h-20 w-20 shrink-0 rounded-md border border-gray-200 object-cover" />
              ) : (
                <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-gray-50">
                  <FileText className="h-8 w-8 text-gray-400" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                {uploading ? (
                  <p className="flex items-center gap-2 text-sm text-gray-600">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                    Reading your receipt…
                  </p>
                ) : ocrRan ? (
                  <p className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
                    <Sparkles className="h-4 w-4 text-brand-600" />
                    Check what we read — correct anything that looks off.
                  </p>
                ) : (
                  <p className="text-sm text-gray-600">Receipt attached.</p>
                )}
                <p className="mt-1 truncate text-xs text-gray-400">{receipt.name}</p>
                <button
                  type="button"
                  onClick={() => { setReceipt(null); setOcrRan(false); setOcrCategorySuggestion(null); }}
                  className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-red-600"
                >
                  <X className="h-3 w-3" /> Remove
                </button>
              </div>
            </div>
          </div>
        )}

        {!receipt && (
          <div className="mt-4 flex items-center justify-between rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-3">
            <p className="text-sm text-gray-500">No receipt attached yet.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => cameraInputRef.current?.click()} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                Scan
              </button>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                Upload
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4 rounded-xl border border-gray-200 bg-white p-5">
          <Field label="Merchant *">
            <input required value={form.merchant} onChange={(e) => set('merchant', e.target.value)} placeholder="Coffee Shop, Airline, etc." className={inputCls} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount *">
              <input required type="number" min="0.01" step="0.01" inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" className={inputCls} />
            </Field>
            <Field label="Date *">
              <input required type="date" value={form.date} onChange={(e) => set('date', e.target.value)} className={inputCls} />
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
              <p className="mt-1 text-xs text-gray-400">Auto-filled from your card — change it if this expense belongs to another company.</p>
            )}
          </Field>

          {form.company && zohoOn && (
            <Field label="Expense category">
              <select
                value={form.zohoExpenseAccountId}
                onChange={(e) => {
                  const acct = expenseAccounts.find((a) => a.accountId === e.target.value);
                  setCategoryAutoSuggested(false);
                  setForm((f) => ({ ...f, zohoExpenseAccountId: e.target.value, zohoExpenseAccountName: acct?.accountName ?? '' }));
                }}
                disabled={accountsLoading}
                className={inputCls}
              >
                <option value="">{accountsLoading ? 'Loading categories…' : '— Select category —'}</option>
                {expenseAccounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>{a.accountName}</option>
                ))}
              </select>
              {categoryAutoSuggested && !!form.zohoExpenseAccountId && (
                <p className="mt-1 text-xs text-gray-400">Suggested from the receipt — change if wrong.</p>
              )}
            </Field>
          )}

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
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
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
            <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={submitting || uploading}
              className="flex-1 rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60 lg:flex-none"
            >
              {submitting ? 'Submitting…' : 'Submit expense'}
            </button>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="rounded-lg border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
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
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      {children}
    </div>
  );
}
