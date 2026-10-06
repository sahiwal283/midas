import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { accountantApi, expenseApi } from '../api/expenses';
import { companyApi } from '../api/companies';
import { VendorCombobox } from './VendorCombobox';
import { CategoryPicker } from './CategoryPicker';
import { EventPicker, useEventPickerAvailable } from './EventPicker';
import { SyncedChangeConfirm } from './SyncedChangeConfirm';
import { cardsForCompany } from '../lib/paymentMethodScope';
import { latestNoteEdit } from '../lib/auditChanges';
import type { Expense } from '../types';

function apiError(err: unknown): { code?: string; message?: string } {
  return (err as { response?: { data?: { error?: { code?: string; message?: string } } } })
    ?.response?.data?.error ?? {};
}

const inputCls = 'w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink placeholder:text-charcoal/40 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

/** Mirror of apps/api/src/lib/queueScope.ts#isDailyExpense: no event row for these. */
function isDailyExpense(sourceApp: string | null | undefined): boolean {
  return sourceApp == null || sourceApp === 'browser_extension';
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-charcoal/40 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-ink sm:text-right">{value}</dd>
    </div>
  );
}

export { Row as DetailRow };

interface Props {
  expense: Expense;
  /**
   * Accountant/admin correction of someone else's expense: company, merchant,
   * amount, date, payment method, event, category and notes. Once the expense
   * is in Zoho Books only the notes and category stay editable, and saving
   * them asks for a "Midas only" confirmation first.
   */
  canEdit?: boolean;
  /** Read the audit trail (accountant-only endpoint) to say who last edited the notes. */
  history?: boolean;
  /** Extra read-only rows under the standard ones — created, reviewer, source… */
  extraRows?: ReactNode;
}

/**
 * The one card that shows an expense's details and, for accountants, edits
 * them in place. It replaced a read-only details card plus a separate
 * "Correct details" card that did nothing but hold an Edit button.
 */
export function ExpenseDetailsCard({ expense, canEdit = false, history = false, extraRows }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmSynced, setConfirmSynced] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ company: '', merchant: '', amount: '', date: '', paymentMethodId: '', eventId: '', categoryId: '', description: '' });
  const pushed = Boolean(expense.zohoExpenseId);
  // Once pushed, Zoho holds the financial record; notes and category are the
  // Midas-side labels the reports read, which is why they alone stay open here.
  const labelsOnly = pushed;
  // The picker hides itself when the trade show link is off; its label has to
  // go with it, or the form shows an "Event" heading over nothing.
  const eventsAvailable = useEventPickerAvailable();

  const { data: paymentMethods = [] } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => expenseApi.paymentMethods(),
    enabled: editing && !labelsOnly,
    staleTime: 60_000,
  });
  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => companyApi.list(),
    enabled: editing && !labelsOnly,
    staleTime: 60_000,
  });
  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => expenseApi.categories(),
    enabled: editing,
    staleTime: 60_000,
  });
  const { data: auditEntries = [] } = useQuery({
    queryKey: ['expense-audit', expense.id],
    queryFn: () => accountantApi.getAuditTrail(expense.id),
    enabled: history,
  });
  const noteEdit = history ? latestNoteEdit(auditEntries) : null;

  // Cards belong to one company: offering another company's card here would
  // only re-create the mismatch the accountant is correcting. Scoped to the
  // company *in the form*, so correcting the company re-scopes the cards in the
  // same pass. The card currently on the expense always stays in the list —
  // dropping it would blank the select and change the record by omission rather
  // than by a decision.
  const selectableCards = cardsForCompany(paymentMethods, form.company, expense.paymentMethodId);
  const hiddenCardCount = paymentMethods.length - selectableCards.length;

  function buildPatch(): Parameters<typeof accountantApi.updateDetails>[1] {
    // Send only what the accountant actually touched — the server treats an
    // absent key as "leave alone", so a no-op patch stays a no-op.
    const patch: Parameters<typeof accountantApi.updateDetails>[1] = {};
    if (form.description.trim() !== (expense.description ?? '').trim()) {
      patch.description = form.description.trim();
    }
    if (form.categoryId && form.categoryId !== (expense.categoryId ?? '')) patch.categoryId = form.categoryId;
    if (labelsOnly) return patch;
    if (form.company && form.company !== (expense.zohoEntity ?? '')) patch.zohoEntity = form.company;
    const merchant = form.merchant.trim();
    if (merchant && merchant !== (expense.merchant ?? '').trim()) patch.merchant = merchant;
    if (form.amount && Number(form.amount) !== Number(expense.amount)) patch.amount = Number(form.amount);
    if (form.date && form.date !== expense.date) patch.date = form.date;
    if (form.paymentMethodId && form.paymentMethodId !== expense.paymentMethodId) {
      patch.paymentMethodId = form.paymentMethodId;
    }
    const currentEventId = (expense.sourceContext as { eventId?: string } | null)?.eventId ?? '';
    if (form.eventId !== currentEventId) patch.eventId = form.eventId || null;
    return patch;
  }

  const mutation = useMutation({
    mutationFn: (confirmed: boolean) =>
      accountantApi.updateDetails(expense.id, { ...buildPatch(), ...(confirmed ? { confirmSynced: true } : {}) }),
    onSuccess: () => {
      closeEditor();
      void qc.invalidateQueries({ queryKey: ['expense', expense.id] });
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      void qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      void qc.invalidateQueries({ queryKey: ['accountant-all'] });
      void qc.invalidateQueries({ queryKey: ['expense-audit', expense.id] });
      void qc.invalidateQueries({ queryKey: ['zoho-readiness', expense.id] });
    },
    onError: (err: unknown) => {
      const { code, message } = apiError(err);
      // The server asks for the same confirmation the form asks for; if the
      // two ever disagree, the server wins and the panel appears.
      if (code === 'CONFIRM_SYNCED') {
        setConfirmSynced(true);
        return;
      }
      setError(
        (code === 'NOT_EDITABLE' || code === 'PERIOD_CLOSED' || code === 'EVENT_NOT_EDITABLE') && message
          ? message
          : message ?? 'Could not save changes. Please try again.',
      );
    },
  });

  function openEditor() {
    setForm({
      company: expense.zohoEntity ?? '',
      merchant: expense.merchant ?? '',
      amount: expense.amount != null ? String(expense.amount) : '',
      date: expense.date ?? '',
      paymentMethodId: expense.paymentMethodId ?? '',
      eventId: (expense.sourceContext as { eventId?: string } | null)?.eventId ?? '',
      categoryId: expense.categoryId ?? '',
      description: expense.description ?? '',
    });
    setError('');
    setConfirmSynced(false);
    setEditing(true);
  }

  function closeEditor() {
    setEditing(false);
    setConfirmSynced(false);
    setError('');
  }

  function handleSave(e: FormEvent) {
    e.preventDefault();
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      closeEditor();
      return;
    }
    if (labelsOnly) {
      setConfirmSynced(true);
      return;
    }
    mutation.mutate(false);
  }

  // What the "Midas only" panel names: exactly the labels being changed.
  const pendingPatch = confirmSynced ? buildPatch() : {};
  const syncedFieldLabel = [
    ...('description' in pendingPatch ? ['the notes'] : []),
    ...('categoryId' in pendingPatch ? ['the category'] : []),
  ].join(' and ') || 'this expense';

  const paymentMethodLabel = expense.paymentMethod
    ? `${expense.paymentMethod.label}${expense.paymentMethod.lastFour ? ` ···${expense.paymentMethod.lastFour}` : ''}`
    : '—';

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5 text-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold text-charcoal/80">Expense Details</h2>
        {canEdit && !editing && (
          <button
            type="button"
            onClick={openEditor}
            className="min-h-11 shrink-0 text-xs font-medium text-brand-600 hover:text-brand-800 lg:min-h-0"
          >
            Edit
          </button>
        )}
      </div>

      {!editing ? (
        <>
          <dl className="space-y-2 text-charcoal/70">
            {/* Event expenses carry their event name in sourceLabel — the
                first thing an accountant needs to place the spend. */}
            {!isDailyExpense(expense.sourceApp) && (
              <Row label="Event" value={expense.sourceLabel ?? '—'} />
            )}
            <Row label="Merchant" value={expense.merchant} />
            <Row label="Amount" value={`${expense.currency} ${Number(expense.amount).toFixed(2)}`} />
            <Row label="Date" value={expense.date} />
            <Row
              label="Category"
              value={expense.zohoExpenseAccountName ?? expense.category?.name ?? '—'}
            />
            <Row label="Payment method" value={paymentMethodLabel} />
            <Row label="Company" value={expense.zohoEntity ?? '—'} />
            <Row label="Submitted by" value={expense.user?.name ?? '—'} />
            {extraRows}
          </dl>
          {(expense.description || noteEdit) && (
            <div className="mt-3 border-t border-ink/5 pt-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-charcoal/40">Notes</p>
                {noteEdit && (
                  <p className="text-xs text-charcoal/40">
                    Edited by {noteEdit.actorName ?? 'System'}
                    {' · '}
                    {new Date(noteEdit.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                )}
              </div>
              <p className="mt-1 break-words text-sm text-charcoal/70">{expense.description || '—'}</p>
            </div>
          )}
        </>
      ) : (
        <form onSubmit={handleSave} className="space-y-3">
          {labelsOnly && (
            <p className="text-xs text-charcoal/50">
              Already in Zoho Books — only the notes and category can be changed here.
            </p>
          )}
          {!labelsOnly && (
            <>
              {/* Company first, as on the submit forms: the cards and vendors below
                  are its Zoho org's, and an expense with none cannot be pushed. */}
              <div>
                <label className="mb-1 block text-xs font-medium text-charcoal/70">Company</label>
                <select
                  value={form.company}
                  onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                  className={inputCls}
                >
                  <option value="">— Select company —</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.name}>{c.name}</option>
                  ))}
                </select>
                {!expense.zohoEntity && (
                  <p className="mt-1 text-xs text-amber-700">
                    No company set — this expense cannot be pushed to Zoho until it has one.
                  </p>
                )}
                {expense.zohoEntity && form.company !== expense.zohoEntity && (
                  <p className="mt-1 text-xs text-charcoal/50">
                    Moving this expense to another company re-reads its expense account from that
                    company's chart of accounts.
                  </p>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-charcoal/70">Merchant</label>
                <VendorCombobox
                  value={form.merchant}
                  onChange={(m) => setForm((f) => ({ ...f, merchant: m }))}
                  zohoEntity={form.company || undefined}
                  disabled={!form.company}
                  placeholder={form.company ? undefined : 'Pick a company first'}
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
                  {selectableCards.map((pm) => (
                    <option key={pm.id} value={pm.id}>
                      {pm.label}{pm.lastFour ? ` ···${pm.lastFour}` : ''}
                    </option>
                  ))}
                </select>
                {form.company && hiddenCardCount > 0 && (
                  <p className="mt-1 text-xs text-charcoal/40">
                    Showing {form.company} cards only ({hiddenCardCount} other {hiddenCardCount === 1 ? 'card' : 'cards'} hidden).
                  </p>
                )}
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
            </>
          )}
          <div>
            <label htmlFor={`details-cat-${expense.id}`} className="mb-1 block text-xs font-medium text-charcoal/70">Category</label>
            {categories.length === 0 ? (
              <p className="text-xs text-charcoal/40">Loading categories…</p>
            ) : (
              <CategoryPicker
                id={`details-cat-${expense.id}`}
                categories={categories}
                value={form.categoryId}
                onChange={(id) => setForm((f) => ({ ...f, categoryId: id }))}
                disabled={mutation.isPending}
              />
            )}
          </div>
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
          {confirmSynced ? (
            <SyncedChangeConfirm
              fieldLabel={syncedFieldLabel}
              pending={mutation.isPending}
              onCancel={() => setConfirmSynced(false)}
              onConfirm={() => mutation.mutate(true)}
            />
          ) : (
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
                onClick={closeEditor}
                className="min-h-11 rounded-lg px-3 py-1.5 text-xs font-medium text-charcoal/70 hover:bg-brand-50 lg:min-h-0"
              >
                Cancel
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
