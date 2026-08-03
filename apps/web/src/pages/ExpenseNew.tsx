import { useState, useEffect, useRef, FormEvent, ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Upload, X, FileText, AlertCircle } from 'lucide-react';
import { expenseApi } from '../api/expenses';
import { enqueueUpload, isLikelyOfflineOrNetworkError } from '../lib/uploadQueue';

export function ExpenseNew() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    merchant: '',
    amount: '',
    date: new Date().toISOString().slice(0, 10),
    currency: 'USD',
    categoryId: '',
    paymentMethodId: '',
    description: '',
  });
  const [receipt, setReceipt] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // Once the draft is created we keep its id so a failed receipt upload can be
  // retried without creating a duplicate (orphan) draft.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => expenseApi.categories(),
  });

  const { data: paymentMethods = [] } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => expenseApi.paymentMethods(),
  });

  // Build/cleanup an object URL for the image preview.
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

  function handleReceiptChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setReceipt(file);
      setError('');
    }
    // Reset so re-selecting the same file still fires onChange.
    e.target.value = '';
  }

  function removeReceipt() {
    setReceipt(null);
    setError('');
  }

  const hasRequiredFields = !!(form.merchant && form.amount && form.date && receipt);
  const canSave = hasRequiredFields && !saving;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!form.merchant || !form.amount || !form.date) {
      setError('Merchant, amount, and date are required.');
      return;
    }
    if (!receipt) {
      setError('A receipt image is required before saving.');
      return;
    }

    setSaving(true);
    const payload = {
      merchant: form.merchant,
      amount: Number(form.amount),
      date: form.date,
      currency: form.currency,
      categoryId: form.categoryId || undefined,
      paymentMethodId: form.paymentMethodId || undefined,
      description: form.description || undefined,
    };

    try {
      // Live sync path — create draft then upload receipt (OCR completes in the upload response).
      let expenseId = createdId;
      if (!expenseId) {
        const expense = await expenseApi.create(payload);
        expenseId = expense.id;
        setCreatedId(expense.id);
        qc.invalidateQueries({ queryKey: ['expenses'] });
      }

      try {
        await expenseApi.uploadReceipt(expenseId, receipt);
      } catch (uploadErr) {
        if (isLikelyOfflineOrNetworkError(uploadErr)) {
          await enqueueUpload({
            payload,
            receipt,
            expenseId,
            lastError: 'Receipt upload failed — queued for retry',
          });
          void qc.invalidateQueries({ queryKey: ['upload-queue-count'] });
          navigate('/to-upload');
          return;
        }
        // Draft exists but receipt failed for a non-network reason — retry on detail page.
        qc.invalidateQueries({ queryKey: ['expense', expenseId] });
        navigate(`/expenses/${expenseId}`, { state: { receiptUploadFailed: true } });
        return;
      }

      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['expense', expenseId] });
      navigate(`/expenses/${expenseId}`);
    } catch (err) {
      if (isLikelyOfflineOrNetworkError(err) && receipt) {
        await enqueueUpload({
          payload,
          receipt,
          lastError: 'Could not reach Midas — saved to To upload',
        });
        void qc.invalidateQueries({ queryKey: ['upload-queue-count'] });
        navigate('/to-upload');
        return;
      }
      setError('Failed to create expense. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">New Expense</h1>
        <p className="mt-1 text-sm text-gray-500">Saved as a draft — submit when ready for accountant review.</p>
      </div>

      <div className="max-w-xl rounded-xl border border-gray-200 bg-white p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* ── Receipt — the primary, first section ─────────────────────── */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Receipt *</label>
            <p className="mb-2 text-xs text-gray-500">
              Attach or photograph the receipt. An image is required before saving.
            </p>

            {!receipt ? (
              <div className="flex flex-col gap-3 rounded-lg border-2 border-dashed border-gray-300 p-6 text-center">
                <p className="text-sm text-gray-500">Upload a receipt image or PDF — or snap a photo.</p>
                <div className="flex flex-wrap justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <Upload className="h-4 w-4" />
                    Choose file
                  </button>
                  <button
                    type="button"
                    onClick={() => cameraInputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <Camera className="h-4 w-4" />
                    Take photo
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-start gap-3">
                  {previewUrl ? (
                    <img
                      src={previewUrl}
                      alt="Receipt preview"
                      className="h-20 w-20 shrink-0 rounded-md border border-gray-200 object-cover"
                    />
                  ) : (
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white">
                      <FileText className="h-8 w-8 text-gray-400" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-800">{receipt.name}</p>
                    <p className="mt-0.5 text-xs text-gray-500">{(receipt.size / 1024).toFixed(0)} KB</p>
                    <div className="mt-2 flex gap-3">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-xs font-medium text-brand-600 hover:text-brand-700"
                      >
                        Change
                      </button>
                      <button
                        type="button"
                        onClick={removeReceipt}
                        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-red-600"
                      >
                        <X className="h-3.5 w-3.5" />
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Hidden inputs — file picker (incl. PDF) and rear-camera capture */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf"
              className="hidden"
              onChange={handleReceiptChange}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleReceiptChange}
            />
          </div>

          <hr className="border-gray-100" />

          <Field label="Merchant *">
            <input
              required
              value={form.merchant}
              onChange={(e) => set('merchant', e.target.value)}
              placeholder="Coffee Shop, Airline, etc."
              className={inputCls}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Amount *">
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </Field>
            <Field label="Currency">
              <select value={form.currency} onChange={(e) => set('currency', e.target.value)} className={inputCls}>
                <option>USD</option>
                <option>EUR</option>
                <option>GBP</option>
                <option>CAD</option>
                <option>MXN</option>
              </select>
            </Field>
          </div>

          <Field label="Date *">
            <input
              required
              type="date"
              value={form.date}
              onChange={(e) => set('date', e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label="Category">
            <select value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} className={inputCls}>
              <option value="">— Select a category —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>

          {paymentMethods.length > 0 && (
            <Field label="Payment method">
              <select value={form.paymentMethodId} onChange={(e) => set('paymentMethodId', e.target.value)} className={inputCls}>
                <option value="">— Select a payment method —</option>
                {paymentMethods.map((pm) => (
                  <option key={pm.id} value={pm.id}>
                    {pm.label}{pm.lastFour ? ` ···${pm.lastFour}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Description">
            <textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={3}
              placeholder="Optional notes about this expense"
              className={`${inputCls} resize-none`}
            />
          </Field>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {error}
                {createdId && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => navigate(`/expenses/${createdId}`)}
                      className="font-semibold underline hover:text-red-800"
                    >
                      Open the draft to add the receipt
                    </button>
                    .
                  </>
                )}
              </span>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={!canSave}
              className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Saving…' : createdId ? 'Retry receipt upload' : 'Save Draft'}
            </button>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="rounded-lg border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      {children}
    </div>
  );
}
