// Pure cash-drawer ledger logic, ported from the standalone Cashbook app
// (lib/cash/ledger.ts) during the merge. No DB, no framework — unit-tested.
// Money is integer cents everywhere.

export const PETTY_CASH_CATEGORY = 'PETTY_CASH';

export type CashEntryKind = 'DEPOSIT' | 'WITHDRAWAL';

export type LedgerEntryLike = {
  kind: CashEntryKind;
  amountCents: number;
  voidedAt?: Date | string | null;
};

/** Positive integer cents or an error message. */
export function validateAmountCents(amountCents: number): string | null {
  if (!Number.isFinite(amountCents)) return 'Amount must be a number.';
  if (!Number.isInteger(amountCents)) return 'Amount must be whole cents.';
  if (amountCents <= 0) return 'Amount must be greater than zero.';
  return null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as YYYY-MM-DD in the server's local timezone. */
export function localTodayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * Validate a transaction date (YYYY-MM-DD). Backdating is allowed — that is
 * the point — but future dates are not: cash can't have moved tomorrow.
 */
export function validateEntryDate(
  entryDate: string,
  todayIso: string = localTodayIso(),
): string | null {
  if (!ISO_DATE_RE.test(entryDate)) {
    return 'Date must be in YYYY-MM-DD format.';
  }
  const [y = 0, m = 0, d = 0] = entryDate.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    return 'That is not a real calendar date.';
  }
  // ISO dates compare correctly as strings.
  if (entryDate > todayIso) return 'Date cannot be in the future.';
  return null;
}

export function validateDeposit(input: {
  amountCents: number;
  invoiceNumber: string;
}): string | null {
  const amountError = validateAmountCents(input.amountCents);
  if (amountError) return amountError;
  if (!input.invoiceNumber.trim()) {
    return 'Invoice number is required for deposits.';
  }
  return null;
}

export function validatePettyCash(input: {
  amountCents: number;
  description: string;
}): string | null {
  const amountError = validateAmountCents(input.amountCents);
  if (amountError) return amountError;
  if (!input.description.trim()) {
    return 'Describe what the petty cash was spent on.';
  }
  return null;
}

/** Balance over non-voided entries: sum(DEPOSIT) - sum(WITHDRAWAL). */
export function computeBalanceCents(entries: readonly LedgerEntryLike[]): number {
  return entries.reduce((sum, e) => {
    if (e.voidedAt) return sum;
    return e.kind === 'DEPOSIT' ? sum + e.amountCents : sum - e.amountCents;
  }, 0);
}

/** Compose the petty-cash note line: "description (ref REF)". */
export function pettyCashNote(
  description: string,
  reference?: string | null,
): string {
  const desc = description.trim();
  const ref = reference?.trim();
  return ref ? `${desc} (ref ${ref})` : desc;
}

// ── CSV export ───────────────────────────────────────────────────────────────

export type CsvEntry = {
  createdAt: Date | string;
  /** Transaction date (YYYY-MM-DD). Falls back to createdAt when absent
   *  (payroll-linked rows, which cannot be backdated). */
  entryDate?: string | null;
  kind: CashEntryKind;
  category: string | null;
  amountCents: number;
  invoiceNumber: string | null;
  notes: string | null;
  createdByLabel: string | null;
};

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Ledger as CSV, newest first as given. Amounts are signed dollars with two
 * decimals so the file drops straight into accounting software.
 */
export function buildLedgerCsv(entries: readonly CsvEntry[]): string {
  const header =
    'date,kind,category,amount,invoice_number,notes,recorded_by,recorded_at';
  const rows = entries.map((e) => {
    const sign = e.kind === 'WITHDRAWAL' ? -1 : 1;
    const dollars = ((sign * e.amountCents) / 100).toFixed(2);
    const recordedAt = new Date(e.createdAt).toISOString();
    const dateField = e.entryDate ?? recordedAt.slice(0, 10);
    return [
      dateField,
      e.kind,
      e.category ?? '',
      dollars,
      e.invoiceNumber ?? '',
      e.notes ?? '',
      e.createdByLabel ?? '',
      recordedAt,
    ]
      .map(csvField)
      .join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}
