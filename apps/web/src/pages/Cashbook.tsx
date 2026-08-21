import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ArrowDownToLine, ArrowUpFromLine, Download, ExternalLink, Paperclip, Plus, ShoppingCart, X } from 'lucide-react';
import { cashbookApi, type CashBusiness, type CashLedgerEntry } from '../api/cashbook';
import { PageHeader } from '../components/PageHeader';
import { ConfirmModal } from '../components/ConfirmModal';

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function todayIso(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

function KindBadge({ entry }: { entry: CashLedgerEntry }) {
  if (entry.kind === 'DEPOSIT') {
    return <span className="inline-flex rounded px-1.5 py-0.5 text-xs font-medium bg-success/15 text-success">Deposit</span>;
  }
  if (entry.category === 'PETTY_CASH') {
    return <span className="inline-flex rounded px-1.5 py-0.5 text-xs font-medium bg-brand-100 text-brand-800">Petty cash</span>;
  }
  return <span className="inline-flex rounded px-1.5 py-0.5 text-xs font-medium bg-gold-100 text-gold-800">Withdrawal</span>;
}

/** One of the three entry forms, collapsed behind its card header. */
type FormKind = 'deposit' | 'petty' | 'withdrawal';

export function Cashbook() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState('');
  const [openForm, setOpenForm] = useState<FormKind | null>(null);
  const [voidTarget, setVoidTarget] = useState<CashLedgerEntry | null>(null);
  const [showNewBusiness, setShowNewBusiness] = useState(false);
  const [newBusinessName, setNewBusinessName] = useState('');

  const { data: bizData, isLoading: bizLoading } = useQuery({
    queryKey: ['cashbook-businesses'],
    queryFn: () => cashbookApi.businesses(),
  });
  const businesses = bizData?.businesses ?? [];

  const activeId = params.get('b') ?? businesses[0]?.id ?? null;
  const active: CashBusiness | null = businesses.find((b) => b.id === activeId) ?? businesses[0] ?? null;

  function selectBusiness(id: string) {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('b', id);
      return p;
    }, { replace: true });
    setOpenForm(null);
    setError('');
  }

  const { data: ledgerData, isLoading: ledgerLoading } = useQuery({
    queryKey: ['cashbook-ledger', active?.id],
    queryFn: () => cashbookApi.ledger(active!.id),
    enabled: Boolean(active?.available),
  });
  const entries = ledgerData?.entries ?? [];
  const payrollAppUrl = ledgerData?.payrollAppUrl ?? bizData?.payrollAppUrl ?? null;

  function refetch() {
    void qc.invalidateQueries({ queryKey: ['cashbook-businesses'] });
    void qc.invalidateQueries({ queryKey: ['cashbook-ledger'] });
  }

  function onMutationError(err: any) {
    setError(err?.response?.data?.error?.message ?? 'Something went wrong.');
  }

  const createBusinessMutation = useMutation({
    mutationFn: () => cashbookApi.createBusiness(newBusinessName.trim()),
    onSuccess: (biz) => {
      setShowNewBusiness(false);
      setNewBusinessName('');
      setError('');
      refetch();
      selectBusiness(biz.id);
    },
    onError: onMutationError,
  });

  const voidMutation = useMutation({
    mutationFn: (entry: CashLedgerEntry) => cashbookApi.voidEntry(active!.id, entry.id),
    onSuccess: () => {
      setVoidTarget(null);
      setError('');
      refetch();
    },
    onError: (err) => {
      setVoidTarget(null);
      onMutationError(err);
    },
  });

  const monthEntries = useMemo(() => entries.length, [entries]);

  return (
    <div className="page">
      <PageHeader
        title="Cashbook"
        subtitle={
          active
            ? `${active.name}${active.payrollLinked ? ' · live view of the payroll app’s cash drawer' : ' · cash drawer ledger'}`
            : 'Cash drawers per business — deposits, petty cash, withdrawals.'
        }
        actions={
          active?.available ? (
            <a href={cashbookApi.exportCsvUrl(active.id)} className="btn-secondary" download>
              <Download className="h-4 w-4" />
              Export CSV
            </a>
          ) : undefined
        }
      />

      {/* Business switcher — same pill pattern as Reports */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Business" className="inline-flex flex-wrap rounded-full border border-ink/10 bg-brand-50 p-1">
          {businesses.map((b) => {
            const isActive = active?.id === b.id;
            return (
              <button
                key={b.id}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => selectBusiness(b.id)}
                className={`min-h-11 cursor-pointer rounded-full px-5 py-2 text-sm font-semibold transition-colors duration-200 lg:min-h-0 ${
                  isActive ? 'bg-brand-500 text-cream shadow-sm' : 'text-charcoal/70 hover:text-ink'
                }`}
              >
                {b.name}
              </button>
            );
          })}
        </div>
        {active?.payrollLinked && (
          <span className="rounded-full bg-gold-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-gold-800">
            Linked to payroll
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowNewBusiness((v) => !v)}
          className="flex min-h-11 items-center gap-1 rounded-full border border-ink/10 px-3 py-1.5 text-sm font-medium text-charcoal/70 hover:bg-ink/[0.03] hover:text-ink lg:min-h-0"
        >
          <Plus className="h-4 w-4" />
          New business
        </button>
      </div>

      {showNewBusiness && (
        <div className="mb-5 flex max-w-md items-end gap-2 rounded-xl border border-ink/10 bg-white p-4">
          <div className="min-w-0 flex-1">
            <label className="field-label">Business name</label>
            <input
              value={newBusinessName}
              onChange={(e) => setNewBusinessName(e.target.value)}
              placeholder="e.g. Riverside Deli LLC"
              className="field"
            />
          </div>
          <button
            type="button"
            onClick={() => createBusinessMutation.mutate()}
            disabled={createBusinessMutation.isPending || !newBusinessName.trim()}
            className="btn-primary disabled:opacity-50"
          >
            {createBusinessMutation.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-start justify-between gap-4 rounded-lg border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span>{error}</span>
          <button onClick={() => setError('')} className="shrink-0 rounded p-0.5 hover:bg-danger/10" aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {bizLoading ? (
        <div className="panel px-6 py-12 text-center text-sm text-charcoal/40">Loading…</div>
      ) : !active ? (
        <div className="panel px-6 py-12 text-center text-sm text-muted">No businesses yet — create one above.</div>
      ) : !active.available ? (
        <div className="panel px-6 py-12 text-center text-sm text-muted">
          The payroll-linked drawer is unavailable: the payroll database connection is not configured.
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-ink/10 bg-white px-4 py-3 shadow-panel">
              <p className="text-xs font-medium text-muted">On hand</p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums text-ink">{usd(active.onHandCents)}</p>
              <p className="mt-0.5 text-[11px] text-charcoal/40">{monthEntries} ledger entries shown</p>
            </div>
            <div className="rounded-xl border border-ink/10 bg-white px-4 py-3 shadow-panel">
              <p className="text-xs font-medium text-muted">Deposits (lifetime)</p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums text-success">{usd(active.depositsCents)}</p>
            </div>
            <div className="rounded-xl border border-ink/10 bg-white px-4 py-3 shadow-panel">
              <p className="text-xs font-medium text-muted">Withdrawals (lifetime)</p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums text-ink">{usd(active.withdrawalsCents)}</p>
            </div>
          </div>

          {/* Action launcher */}
          <div className="mb-3 flex flex-wrap gap-2">
            <ActionCardButton
              icon={<ArrowDownToLine className="h-4 w-4" />}
              label="Add cash"
              active={openForm === 'deposit'}
              onClick={() => setOpenForm(openForm === 'deposit' ? null : 'deposit')}
            />
            <ActionCardButton
              icon={<ShoppingCart className="h-4 w-4" />}
              label="Petty cash purchase"
              active={openForm === 'petty'}
              onClick={() => setOpenForm(openForm === 'petty' ? null : 'petty')}
            />
            <ActionCardButton
              icon={<ArrowUpFromLine className="h-4 w-4" />}
              label="Manual withdrawal"
              active={openForm === 'withdrawal'}
              onClick={() => setOpenForm(openForm === 'withdrawal' ? null : 'withdrawal')}
            />
          </div>

          {openForm && (
            <EntryForm
              key={`${active.id}-${openForm}`}
              kind={openForm}
              business={active}
              onDone={() => {
                setOpenForm(null);
                setError('');
                refetch();
              }}
              onError={onMutationError}
            />
          )}

          {/* Ledger */}
          <div className="panel mt-4">
            <div className="border-b border-ink/5 px-4 py-3">
              <h2 className="text-sm font-semibold text-ink">Ledger</h2>
              <p className="text-xs text-charcoal/40">Newest first.</p>
            </div>
            {ledgerLoading ? (
              <div className="px-6 py-12 text-center text-sm text-charcoal/40">Loading…</div>
            ) : entries.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-muted">No ledger entries yet.</div>
            ) : (
              <>
                {/* Mobile cards */}
                <div className="divide-y divide-ink/5 md:hidden">
                  {entries.map((e) => (
                    <div key={e.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <KindBadge entry={e} />
                        <p className={`shrink-0 font-semibold tabular-nums ${e.kind === 'DEPOSIT' ? 'text-success' : 'text-danger'}`}>
                          {e.kind === 'DEPOSIT' ? '' : '-'}{usd(e.amountCents)}
                        </p>
                      </div>
                      <p className="mt-1 text-xs text-charcoal/70">{entryContext(e)}</p>
                      {e.notes && <p className="mt-0.5 text-xs text-muted">{e.notes}</p>}
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-charcoal/40">
                        <span>{new Date(e.createdAt).toLocaleString()}{e.createdByLabel ? ` · ${e.createdByLabel}` : ''}</span>
                        <EntryActions entry={e} business={active} payrollAppUrl={payrollAppUrl} onVoid={() => setVoidTarget(e)} />
                      </div>
                    </div>
                  ))}
                </div>
                {/* Desktop table */}
                <table className="hidden w-full text-sm md:table">
                  <thead>
                    <tr className="border-b border-ink/10 bg-brand-50/80 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                      <th className="px-4 py-2.5">Date</th>
                      <th className="px-4 py-2.5">Kind</th>
                      <th className="px-4 py-2.5">Invoice / Period</th>
                      <th className="px-4 py-2.5">Notes</th>
                      <th className="px-4 py-2.5 text-right">Amount</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/5">
                    {entries.map((e) => (
                      <tr key={e.id} className="hover:bg-ink/[0.03]">
                        <td className="whitespace-nowrap px-4 py-3 text-charcoal/70">
                          {e.entryDate ?? new Date(e.createdAt).toLocaleDateString()}
                          <p className="text-[11px] text-charcoal/40">{new Date(e.createdAt).toLocaleTimeString()}</p>
                        </td>
                        <td className="px-4 py-3"><KindBadge entry={e} /></td>
                        <td className="px-4 py-3 text-charcoal/70">{entryContext(e) || '—'}</td>
                        <td className="max-w-md px-4 py-3">
                          <p className="text-charcoal/80">{e.notes ?? '—'}</p>
                          {e.createdByLabel && <p className="text-[11px] text-charcoal/40">by {e.createdByLabel}</p>}
                        </td>
                        <td className={`px-4 py-3 text-right font-semibold tabular-nums ${e.kind === 'DEPOSIT' ? 'text-success' : 'text-danger'}`}>
                          {e.kind === 'DEPOSIT' ? '' : '-'}{usd(e.amountCents)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <EntryActions entry={e} business={active} payrollAppUrl={payrollAppUrl} onVoid={() => setVoidTarget(e)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </>
      )}

      <ConfirmModal
        open={voidTarget !== null}
        title="Void this entry?"
        confirmLabel="Void entry"
        danger
        loading={voidMutation.isPending}
        onConfirm={() => voidTarget && voidMutation.mutate(voidTarget)}
        onCancel={() => setVoidTarget(null)}
      >
        <p>
          Voiding removes {voidTarget ? usd(voidTarget.amountCents) : ''} ({voidTarget?.kind.toLowerCase()}) from the
          drawer balance. The entry stays in the audit history — nothing is deleted.
        </p>
      </ConfirmModal>
    </div>
  );
}

function entryContext(e: CashLedgerEntry): string {
  if (e.periodLinked && e.periodStart && e.periodEnd) return `Payroll ${e.periodStart} – ${e.periodEnd}`;
  return e.invoiceNumber ?? '';
}

function ActionCardButton({ icon, label, active, onClick }: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className={`flex min-h-11 items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-semibold shadow-sm transition-colors lg:min-h-0 ${
        active
          ? 'border-brand-500 bg-brand-500 text-cream'
          : 'border-ink/10 bg-white text-charcoal/80 hover:bg-ink/[0.03]'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function EntryActions({ entry, business, payrollAppUrl, onVoid }: {
  entry: CashLedgerEntry;
  business: CashBusiness;
  payrollAppUrl: string | null;
  onVoid: () => void;
}) {
  if (entry.periodLinked) {
    return payrollAppUrl ? (
      <a
        href={payrollAppUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
        title="Recorded by a payroll run — manage it in the payroll app"
      >
        payroll
        <ExternalLink className="h-3 w-3" />
      </a>
    ) : (
      <span className="text-xs text-charcoal/40" title="Recorded by a payroll run">payroll</span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      {entry.receiptPath && !business.payrollLinked && (
        <a
          href={cashbookApi.receiptUrl(business.id, entry.id)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-charcoal/70 hover:text-ink hover:underline"
        >
          <Paperclip className="h-3 w-3" />
          receipt
        </a>
      )}
      <button
        type="button"
        onClick={onVoid}
        className="rounded-md border border-danger/30 bg-white px-2.5 py-1 text-xs font-semibold text-danger shadow-sm hover:bg-danger/10"
      >
        Void
      </button>
    </span>
  );
}

// ── Entry forms ───────────────────────────────────────────────────────────────

function EntryForm({ kind, business, onDone, onError }: {
  kind: FormKind;
  business: CashBusiness;
  onDone: () => void;
  onError: (err: any) => void;
}) {
  const [amount, setAmount] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [entryDate, setEntryDate] = useState(todayIso());
  const [receipt, setReceipt] = useState<File | null>(null);

  // The payroll drawer has no entry_date column — its rows can't be backdated.
  const showDate = !business.payrollLinked;

  const mutation = useMutation({
    mutationFn: () => {
      if (kind === 'deposit') {
        return cashbookApi.deposit(business.id, {
          amount,
          invoiceNumber,
          notes: notes.trim() || undefined,
          ...(showDate ? { entryDate } : {}),
        });
      }
      if (kind === 'withdrawal') {
        return cashbookApi.withdrawal(business.id, {
          amount,
          notes: notes.trim() || undefined,
          ...(showDate ? { entryDate } : {}),
        });
      }
      const form = new FormData();
      form.set('amount', amount);
      form.set('description', description);
      if (reference.trim()) form.set('reference', reference.trim());
      if (showDate) form.set('entryDate', entryDate);
      if (receipt) form.set('receipt', receipt);
      return cashbookApi.pettyCash(business.id, form);
    },
    onSuccess: onDone,
    onError,
  });

  const titles: Record<FormKind, { title: string; hint: string; cta: string }> = {
    deposit: { title: 'Add cash to the drawer', hint: 'Required: invoice number for the source of the deposit.', cta: 'Record deposit' },
    petty: { title: 'Petty cash purchase', hint: 'Record a purchase paid from the drawer (office supplies, etc.).', cta: 'Record purchase' },
    withdrawal: { title: 'Manual withdrawal', hint: 'Cash leaving the drawer for anything that is not a purchase.', cta: 'Withdraw' },
  };
  const meta = titles[kind];
  const canSubmit = Number(amount) > 0
    && (kind !== 'deposit' || invoiceNumber.trim().length > 0)
    && (kind !== 'petty' || description.trim().length > 0);

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-4">
      <p className="text-sm font-semibold text-ink">{meta.title}</p>
      <p className="mt-0.5 text-xs text-muted">{meta.hint}</p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="field-label">Amount ($)</label>
          <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="field" />
        </div>
        {showDate && (
          <div>
            <label className="field-label">Date</label>
            <input type="date" value={entryDate} max={todayIso()} onChange={(e) => setEntryDate(e.target.value)} className="field" />
          </div>
        )}
        {kind === 'deposit' && (
          <div>
            <label className="field-label">Invoice number</label>
            <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="INV-12345" className="field" />
          </div>
        )}
        {kind === 'petty' && (
          <>
            <div>
              <label className="field-label">What was purchased</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. office supplies, stamps" className="field" />
            </div>
            <div>
              <label className="field-label">Receipt # <span className="font-normal text-charcoal/40">(optional)</span></label>
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="RCPT-001" className="field" />
            </div>
            <div>
              <label className="field-label">Receipt file <span className="font-normal text-charcoal/40">(optional)</span></label>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-charcoal/70 file:mr-2 file:rounded-lg file:border file:border-ink/10 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-charcoal/80 hover:file:bg-ink/[0.03]"
              />
            </div>
          </>
        )}
        {kind !== 'petty' && (
          <div className={kind === 'deposit' ? 'sm:col-span-2 lg:col-span-1' : 'sm:col-span-2'}>
            <label className="field-label">{kind === 'withdrawal' ? 'Reason / notes' : 'Notes (optional)'}</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className="field" />
          </div>
        )}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !canSubmit}
          className="btn-primary disabled:opacity-50"
        >
          {mutation.isPending ? 'Saving…' : meta.cta}
        </button>
      </div>
    </div>
  );
}
