import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { accountantApi, expenseApi } from '../api/expenses';
import { VendorCombobox } from './VendorCombobox';
import { EventPicker, useEventPickerAvailable } from './EventPicker';
import type { Expense } from '../types';

function apiError(err: unknown): { code?: string; message?: string } {
  return (err as { response?: { data?: { error?: { code?: string; message?: string } } } })
    ?.response?.data?.error ?? {};
}

const inputCls = 'w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink placeholder:text-charcoal/40 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

/**
 * Accountant correction for the push blockers that had no control of their own:
 * payment method, merchant, amount, date and notes. Category, company, reference
 * number and reimbursement each have their own component already.
 */
export function AccountantDetailsEdit({ expense }: { expense: Expense }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ merchant: '', amount: '', date: '', paymentMethodId: '', eventId: '', description: '' });
  const locked = Boolean(expense.zohoExpenseId);
  // The picker hides itself when the trade show link is off; its label has to
  // go with it, or the form shows an "Event" heading over nothing.
  const eventsAvailable = useEventPickerAvailable();

  const { data: paymentMethods = [] } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => expenseApi.paymentMethods(),
    enabled: editing,
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: () => {
      // Send only what the accountant actually touched — the server treats an
      // absent key as "leave alone", so a no-op patch stays a no-op.
      const patch: { merchant?: string; amount?: number; date?: string; paymentMethodId?: string; description?: string; eventId?: string | null } = {};
      const merchant = form.merchant.trim();
      if (merchant && merchant !== (expense.merchant ?? '').trim()) patch.merchant = merchant;
      if (form.amount && Number(form.amount) !== Number(expense.amount)) patch.amount = Number(form.amount);
      if (form.date && form.date !== expense.date) patch.date = form.date;
      if (form.paymentMethodId && form.paymentMethodId !== expense.paymentMethodId) {
        patch.paymentMethodId = form.paymentMethodId;
      }
      if (form.description.trim() !== (expense.description ?? '').trim()) {
        patch.description = form.description.trim();
      }
      const currentEventId = (expense.sourceContext as { eventId?: string } | null)?.eventId ?? '';
      if (form.eventId !== currentEventId) patch.eventId = form.eventId || null;
      return accountantApi.updateDetails(expense.id, patch);
    },
    onSuccess: () => {
      setEditing(false);
      setError('');
      void qc.invalidateQueries({ queryKey: ['expense', expense.id] });
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      void qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      void qc.invalidateQueries({ queryKey: ['accountant-all'] });
      void qc.invalidateQueries({ queryKey: ['expense-audit', expense.id] });
      void qc.invalidateQueries({ queryKey: ['zoho-readiness', expense.id] });
    },
    onError: (err: unknown) => {
      const { code, message } = apiError(err);
      setError(
        (code === 'NOT_EDITABLE' || code === 'PERIOD_CLOSED' || code === 'EVENT_NOT_EDITABLE') && message
          ? message
          : message ?? 'Could not save changes. Please try again.',
      );
    },
  });

  function openEditor() {
    setForm({
      merchant: expense.merchant ?? '',
      amount: expense.amount != null ? String(expense.amount) : '',
      date: expense.date ?? '',
      paymentMethodId: expense.paymentMethodId ?? '',
      eventId: (expense.sourceContext as { eventId?: string } | null)?.eventId ?? '',
      description: expense.description ?? '',
    });
    setError('');
    setEditing(true);
  }

  function handleSave(e: FormEvent) {
    e.preventDefault();
    mutation.mutate();
  }

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-charcoal/80">Correct details</h2>
        {!editing && !locked && (
          <button
            type="button"
            onClick={openEditor}
            className="shrink-0 text-xs font-medium text-brand-600 hover:text-brand-800"
          >
            Edit
          </button>
        )}
      </div>

      {locked ? (
        <p className="mt-2 text-xs text-charcoal/40">
          Already in Zoho Books — corrections require an explicit adjustment.
        </p>
      ) : !editing ? (
        <p className="mt-2 text-xs text-charcoal/40">
          Fix the merchant, amount, date, payment method
          {eventsAvailable ? ', event or notes' : ' or notes'}
          {' '}without sending it back to the submitter.
        </p>
      ) : (
        <form onSubmit={handleSave} className="mt-3 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-charcoal/70">Merchant</label>
            <VendorCombobox
              value={form.merchant}
              onChange={(m) => setForm((f) => ({ ...f, merchant: m }))}
              zohoEntity={expense.zohoEntity || undefined}
              inputClassName={inputCls}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-charcoal/70">Amount</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-charcoal/70">Date</label>
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                className={inputCls}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-charcoal/70">Payment method</label>
            <select
              value={form.paymentMethodId}
              onChange={(e) => setForm((f) => ({ ...f, paymentMethodId: e.target.value }))}
              className={inputCls}
            >
              <option value="">— Select payment method —</option>
              {paymentMethods.map((pm) => (
                <option key={pm.id} value={pm.id}>
                  {pm.label}{pm.lastFour ? ` ···${pm.lastFour}` : ''}
                </option>
              ))}
            </select>
          </div>
          {eventsAvailable && (
            <div>
              <label className="mb-1 block text-xs font-medium text-charcoal/60">Event</label>
              <EventPicker
                value={form.eventId}
                onChange={(id) => setForm((f) => ({ ...f, eventId: id }))}
                className={inputCls}
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-charcoal/70">Notes</label>
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Add or amend the notes"
              className={inputCls}
            />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={mutation.isPending}
              className="min-h-11 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-cream hover:bg-brand-700 disabled:opacity-60 lg:min-h-0"
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setError(''); }}
              className="min-h-11 rounded-lg px-3 py-1.5 text-xs font-medium text-charcoal/70 hover:bg-brand-50 lg:min-h-0"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
