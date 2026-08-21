// Write-through access to the payroll app's cash drawer, ported from the
// standalone Cashbook app (lib/payroll/drawer.ts) during the merge. Every
// operation replicates the payroll app's own invariants exactly:
//   • balance = sum(DEPOSIT) - sum(WITHDRAWAL) over non-voided rows, never < 0
//   • withdrawals serialize on the SAME advisory lock the payroll app takes,
//     so a Midas withdrawal and a payroll run can't jointly overdraft
//   • every mutation writes a payroll audit_log row in the same transaction
//   • period-linked withdrawals (recorded by payroll runs) are read-only here
//
// Raw SQL on purpose: the payroll schema is owned by the payroll repo, and a
// duplicated Drizzle schema would drift. Column names match the payroll app's
// cash_drawer_entries / audit_log / pay_periods tables.
//
// Midas actors are not payroll users, so actor_id/actor_role are NULL (the
// payroll FKs allow it); the acting Midas user is recorded in the audit
// `after` payload and user_agent is 'midas'.

import { Pool, type PoolClient } from 'pg';
import {
  PETTY_CASH_CATEGORY,
  pettyCashNote,
  validateAmountCents,
  validateDeposit,
  validatePettyCash,
} from './cashLedger';
import { createError } from '../middleware/error';

/** Same constant as the payroll app's cash-drawer queries. */
const CASH_DRAWER_LOCK_KEY = 48230011;

let cached: Pool | null = null;

export function isPayrollDrawerEnabled(): boolean {
  return Boolean(process.env.PAYROLL_DATABASE_URL);
}

function payrollPool(): Pool {
  const url = process.env.PAYROLL_DATABASE_URL;
  if (!url) {
    throw createError('Payroll drawer is not configured (PAYROLL_DATABASE_URL unset).', 503, 'PAYROLL_LINK_DISABLED');
  }
  cached ??= new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30_000 });
  return cached;
}

/** Base URL of the payroll app UI, for deep links from period-linked rows. */
export function payrollAppUrl(): string | null {
  return process.env.PAYROLL_APP_URL || null;
}

export type PayrollLedgerRow = {
  id: string;
  kind: 'DEPOSIT' | 'WITHDRAWAL';
  amountCents: number;
  invoiceNumber: string | null;
  notes: string | null;
  category: string | null;
  receiptPath: string | null;
  periodId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  createdByLabel: string | null;
  createdAt: Date;
};

/** The Midas user performing the action, recorded in payroll audit rows. */
export type MidasActor = { id: string; email: string | null; name: string };

function dateStr(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}

async function balanceCents(client: PoolClient | Pool): Promise<number> {
  const { rows } = await client.query(`
    SELECT
      COALESCE(SUM(CASE WHEN kind = 'DEPOSIT' THEN amount_cents ELSE 0 END), 0) AS deposits,
      COALESCE(SUM(CASE WHEN kind = 'WITHDRAWAL' THEN amount_cents ELSE 0 END), 0) AS withdrawals
    FROM cash_drawer_entries
    WHERE voided_at IS NULL
  `);
  const row = rows[0];
  return Number(row?.deposits ?? 0) - Number(row?.withdrawals ?? 0);
}

export async function getPayrollDrawerTotals(): Promise<{ onHandCents: number; depositsCents: number; withdrawalsCents: number; entryCount: number }> {
  const { rows } = await payrollPool().query(`
    SELECT
      COALESCE(SUM(CASE WHEN kind = 'DEPOSIT' THEN amount_cents ELSE 0 END), 0) AS deposits,
      COALESCE(SUM(CASE WHEN kind = 'WITHDRAWAL' THEN amount_cents ELSE 0 END), 0) AS withdrawals,
      COUNT(*) AS n
    FROM cash_drawer_entries
    WHERE voided_at IS NULL
  `);
  const row = rows[0] ?? { deposits: 0, withdrawals: 0, n: 0 };
  const deposits = Number(row.deposits);
  const withdrawals = Number(row.withdrawals);
  return { onHandCents: deposits - withdrawals, depositsCents: deposits, withdrawalsCents: withdrawals, entryCount: Number(row.n) };
}

export async function listPayrollEntries(limit = 500): Promise<PayrollLedgerRow[]> {
  const { rows } = await payrollPool().query(
    `SELECT e.id, e.kind, e.amount_cents, e.invoice_number, e.notes, e.category,
            e.receipt_path, e.period_id,
            p.start_date AS period_start, p.end_date AS period_end,
            u.email AS created_by_email,
            e.created_at
     FROM cash_drawer_entries e
     LEFT JOIN pay_periods p ON p.id = e.period_id
     LEFT JOIN users u ON u.id = e.created_by_id
     WHERE e.voided_at IS NULL
     ORDER BY e.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountCents: Number(r.amount_cents),
    invoiceNumber: r.invoice_number,
    notes: r.notes,
    category: r.category,
    receiptPath: r.receipt_path,
    periodId: r.period_id,
    periodStart: dateStr(r.period_start),
    periodEnd: dateStr(r.period_end),
    createdByLabel: r.created_by_email,
    createdAt: r.created_at,
  }));
}

async function writePayrollAudit(
  client: PoolClient,
  actor: MidasActor,
  action: string,
  targetId: string,
  after: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, before, after, ip, user_agent)
     VALUES (NULL, NULL, $1, 'CashDrawerEntry', $2, NULL, $3::jsonb, NULL, 'midas')`,
    [action, targetId, JSON.stringify({ ...after, via: 'midas', midasActor: { id: actor.id, email: actor.email, name: actor.name } })],
  );
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await payrollPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function recordPayrollDeposit(
  input: { amountCents: number; invoiceNumber: string; notes?: string | null },
  actor: MidasActor,
): Promise<{ id: string }> {
  const invalid = validateDeposit(input);
  if (invalid) throw createError(invalid, 400, 'INVALID_ENTRY');
  return inTransaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO cash_drawer_entries (kind, amount_cents, invoice_number, notes, created_by_id)
       VALUES ('DEPOSIT', $1, $2, $3, NULL)
       RETURNING id`,
      [input.amountCents, input.invoiceNumber.trim(), input.notes?.trim() || null],
    );
    const row = rows[0];
    if (!row) throw new Error('recordPayrollDeposit: insert empty');
    await writePayrollAudit(tx, actor, 'cash_drawer.deposit', row.id, {
      kind: 'DEPOSIT',
      amountCents: input.amountCents,
      invoiceNumber: input.invoiceNumber.trim(),
    });
    return row;
  });
}

export async function recordPayrollWithdrawal(
  input: { amountCents: number; notes?: string | null; category?: string | null; receiptPath?: string | null },
  actor: MidasActor,
): Promise<{ id: string }> {
  const invalid = validateAmountCents(input.amountCents);
  if (invalid) throw createError(invalid, 400, 'INVALID_ENTRY');
  return inTransaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [CASH_DRAWER_LOCK_KEY]);
    const balance = await balanceCents(tx);
    if (balance - input.amountCents < 0) {
      throw createError(
        `Insufficient cash on hand. Drawer balance is $${(balance / 100).toFixed(2)}; tried to withdraw $${(input.amountCents / 100).toFixed(2)}.`,
        409,
        'INSUFFICIENT_CASH',
      );
    }
    const { rows } = await tx.query(
      `INSERT INTO cash_drawer_entries (kind, amount_cents, invoice_number, notes, category, receipt_path, period_id, created_by_id)
       VALUES ('WITHDRAWAL', $1, NULL, $2, $3, $4, NULL, NULL)
       RETURNING id`,
      [input.amountCents, input.notes?.trim() || null, input.category ?? null, input.receiptPath ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('recordPayrollWithdrawal: insert empty');
    await writePayrollAudit(tx, actor, 'cash_drawer.withdraw', row.id, {
      kind: 'WITHDRAWAL',
      amountCents: input.amountCents,
      category: input.category ?? null,
    });
    return row;
  });
}

export async function recordPayrollPettyCash(
  input: { amountCents: number; description: string; reference?: string | null; receiptPath?: string | null },
  actor: MidasActor,
): Promise<{ id: string }> {
  const invalid = validatePettyCash(input);
  if (invalid) throw createError(invalid, 400, 'INVALID_ENTRY');
  return recordPayrollWithdrawal(
    {
      amountCents: input.amountCents,
      notes: pettyCashNote(input.description, input.reference),
      category: PETTY_CASH_CATEGORY,
      receiptPath: input.receiptPath ?? null,
    },
    actor,
  );
}

export async function voidPayrollEntry(id: string, actor: MidasActor): Promise<void> {
  await inTransaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [CASH_DRAWER_LOCK_KEY]);
    const { rows } = await tx.query(
      'SELECT id, kind, amount_cents, period_id, voided_at FROM cash_drawer_entries WHERE id = $1',
      [id],
    );
    const entry = rows[0];
    if (!entry) throw createError('Ledger entry not found.', 404, 'NOT_FOUND');
    if (entry.voided_at) throw createError('Entry is already voided.', 409, 'ALREADY_VOIDED');
    if (entry.period_id) {
      throw createError(
        'This withdrawal was recorded by a payroll run — manage it from the payroll app.',
        409,
        'PAYROLL_RUN_ENTRY',
      );
    }
    if (entry.kind === 'DEPOSIT') {
      const balance = await balanceCents(tx);
      if (balance - Number(entry.amount_cents) < 0) {
        throw createError('Voiding this deposit would drop the drawer below zero.', 409, 'INSUFFICIENT_CASH');
      }
    }
    await tx.query(
      'UPDATE cash_drawer_entries SET voided_at = NOW(), voided_by_id = NULL WHERE id = $1 AND voided_at IS NULL',
      [id],
    );
    await writePayrollAudit(tx, actor, 'cash_drawer.void', id, {
      kind: entry.kind,
      amountCents: Number(entry.amount_cents),
    });
  });
}
