import { describe, expect, it } from 'vitest';
import {
  buildLedgerCsv,
  computeBalanceCents,
  pettyCashNote,
  validateAmountCents,
  validateDeposit,
  validateEntryDate,
  validatePettyCash,
} from '../lib/cashLedger';

describe('validateAmountCents', () => {
  it('accepts positive integer cents', () => {
    expect(validateAmountCents(1)).toBeNull();
    expect(validateAmountCents(1_250_000)).toBeNull();
  });
  it('rejects zero, negatives, fractions, and non-numbers', () => {
    expect(validateAmountCents(0)).toMatch(/greater than zero/);
    expect(validateAmountCents(-5)).toMatch(/greater than zero/);
    expect(validateAmountCents(10.5)).toMatch(/whole cents/);
    expect(validateAmountCents(NaN)).toMatch(/must be a number/);
    expect(validateAmountCents(Infinity)).toMatch(/must be a number/);
  });
});

describe('validateEntryDate', () => {
  it('accepts today and the past', () => {
    expect(validateEntryDate('2026-08-21', '2026-08-21')).toBeNull();
    expect(validateEntryDate('2020-01-01', '2026-08-21')).toBeNull();
  });
  it('rejects the future, bad formats, and fake dates', () => {
    expect(validateEntryDate('2026-08-22', '2026-08-21')).toMatch(/future/);
    expect(validateEntryDate('08/21/2026', '2026-08-21')).toMatch(/YYYY-MM-DD/);
    expect(validateEntryDate('2026-02-30', '2026-08-21')).toMatch(/not a real/);
  });
});

describe('deposit and petty-cash validation', () => {
  it('deposits require an invoice number', () => {
    expect(validateDeposit({ amountCents: 100, invoiceNumber: '  ' })).toMatch(/Invoice number/);
    expect(validateDeposit({ amountCents: 100, invoiceNumber: 'INV-1' })).toBeNull();
  });
  it('petty cash requires a description', () => {
    expect(validatePettyCash({ amountCents: 100, description: '' })).toMatch(/Describe/);
    expect(validatePettyCash({ amountCents: 100, description: 'stamps' })).toBeNull();
  });
});

describe('computeBalanceCents', () => {
  it('sums deposits minus withdrawals, skipping voided rows', () => {
    expect(computeBalanceCents([
      { kind: 'DEPOSIT', amountCents: 10_000 },
      { kind: 'WITHDRAWAL', amountCents: 2_500 },
      { kind: 'WITHDRAWAL', amountCents: 9_999, voidedAt: new Date() },
    ])).toBe(7_500);
  });
});

describe('pettyCashNote', () => {
  it('appends the reference when present', () => {
    expect(pettyCashNote('stamps', 'RCPT-9')).toBe('stamps (ref RCPT-9)');
    expect(pettyCashNote(' stamps ', null)).toBe('stamps');
  });
});

describe('buildLedgerCsv', () => {
  it('signs withdrawals, quotes fields, prefers entryDate over recorded date', () => {
    const csv = buildLedgerCsv([
      {
        createdAt: '2026-08-21T15:00:00.000Z',
        entryDate: '2026-08-01',
        kind: 'WITHDRAWAL',
        category: 'PETTY_CASH',
        amountCents: 2_500,
        invoiceNumber: null,
        notes: 'gas, "urgent"',
        createdByLabel: 'Sahil',
      },
    ]);
    const [header, row] = csv.trim().split('\n');
    expect(header).toBe('date,kind,category,amount,invoice_number,notes,recorded_by,recorded_at');
    expect(row).toContain('2026-08-01,WITHDRAWAL,PETTY_CASH,-25.00,');
    expect(row).toContain('"gas, ""urgent"""');
  });
  it('falls back to the recorded date for payroll-linked rows', () => {
    const csv = buildLedgerCsv([
      {
        createdAt: '2026-08-21T15:00:00.000Z',
        entryDate: null,
        kind: 'DEPOSIT',
        category: null,
        amountCents: 100,
        invoiceNumber: 'INV-1',
        notes: null,
        createdByLabel: null,
      },
    ]);
    expect(csv.split('\n')[1]).toContain('2026-08-21,DEPOSIT');
  });
});
