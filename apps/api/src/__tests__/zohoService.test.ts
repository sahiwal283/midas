/**
 * Unit tests for the Zoho Integration Service client, health probe, and payload mapping.
 * No database or real network — global fetch is stubbed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Mock env so tests don't require real DATABASE_URL/JWT_SECRET. The same mocked object is
// shared with lib/zoho.ts and lib/zohoPayload.ts; tests mutate it per-case.
vi.mock('../config/env', () => ({
  env: {
    ZOHO_MODE: 'mock' as const,
    ZOHO_DRY_RUN: false,
    ZOHO_DEFAULT_BRAND: 'haute_brands',
    ZOHO_SERVICE_BASE_URL: undefined as string | undefined,
    ZOHO_SERVICE_TOKEN: undefined as string | undefined,
  },
}));

import { ServiceZohoAdapter, checkServiceHealth, checkZohoAuth, ZohoServiceError, zoho } from '../lib/zoho';
import { buildZohoServicePayload, buildIdempotencyKey, type PayloadExpense } from '../lib/zohoPayload';
import { env } from '../config/env';

const TOKEN = 'super-secret-internal-token-VALUE';

const baseExpense: PayloadExpense = {
  id: 'exp-123',
  merchant: 'Acme Cafe',
  amount: '42.00',
  currency: 'USD',
  date: '2026-06-24',
  description: 'Team lunch',
  categoryId: 'cat-1',
  paymentMethodId: 'pm-1',
  zohoEntity: 'Haute Brands',
  zohoExpenseAccountId: null,
  reimbursementStatus: 'not_requested',
  userId: 'user-1',
  category: { name: 'Meals & Entertainment', zohoAccountId: '5254962000000091710' },
  paymentMethod: { label: 'Corporate Amex', zohoAccountName: '5254962000002038541' },
  receipts: [{ id: 'r1' }],
};

describe('buildIdempotencyKey', () => {
  it('is deterministic per expense id', () => {
    expect(buildIdempotencyKey('exp-123')).toBe('midas-expense-exp-123');
    expect(buildIdempotencyKey('exp-123')).toBe(buildIdempotencyKey('exp-123'));
  });
});

describe('buildZohoServicePayload', () => {
  it('maps core fields, idempotency key, and proposed account placeholders', () => {
    const p = buildZohoServicePayload(baseExpense);
    expect(p.idempotencyKey).toBe('midas-expense-exp-123');
    expect(p.expenseId).toBe('exp-123');
    expect(p.amount).toBe('42.00');
    expect(p.account_id).toBe('5254962000000091710');
    expect(p.paid_through_account_id).toBe('5254962000002038541');
    expect(p.category).toEqual({
      id: 'cat-1', name: 'Meals & Entertainment', proposedZohoAccount: '5254962000000091710',
    });
    expect(p.paymentMethod).toEqual({
      id: 'pm-1', label: 'Corporate Amex', proposedPaidThroughAccount: '5254962000002038541',
    });
    expect(p.brand).toBe('haute_brands'); // from zohoEntity via resolveBrandFromEntity
    expect(p.submitter).toEqual({ userId: 'user-1' });
    expect(p.receipt).toEqual({ count: 1 });
    expect(p.reference_number).toBeUndefined();
  });

  it('sends a trimmed reference_number when the expense has one', () => {
    const p = buildZohoServicePayload({ ...baseExpense, referenceNumber: '  INV-42  ' });
    expect(p.reference_number).toBe('INV-42');
  });

  it('defaults source.app to "midas" and is generic (no event_id coupling)', () => {
    const p = buildZohoServicePayload(baseExpense);
    expect(p.source.app).toBe('midas');
    expect(p).not.toHaveProperty('event_id');
    expect(p).not.toHaveProperty('eventId');
    expect(p.source).not.toHaveProperty('event_id');
  });

  it('passes through generic source fields from any source app', () => {
    const p = buildZohoServicePayload({
      ...baseExpense,
      sourceApp: 'argo',
      sourceType: 'trade_show',
      sourceRefId: 'booth-99',
      sourceUrl: 'https://argo/expense/9',
      sourceLabel: 'Argo • Booth 99',
    });
    expect(p.source).toEqual({
      app: 'argo', type: 'trade_show', id: 'booth-99',
      url: 'https://argo/expense/9', label: 'Argo • Booth 99',
    });
  });

  it('derives reimbursable from reimbursement status', () => {
    expect(buildZohoServicePayload(baseExpense).reimbursable).toBe(false);
    expect(buildZohoServicePayload({ ...baseExpense, reimbursementStatus: 'pending' }).reimbursable).toBe(true);
  });
});

describe('ServiceZohoAdapter auth + redaction', () => {
  let savedToken: string | undefined;
  let savedBase: string | undefined;
  let savedDry: boolean;

  beforeEach(() => {
    savedToken = env.ZOHO_SERVICE_TOKEN;
    savedBase = env.ZOHO_SERVICE_BASE_URL;
    savedDry = env.ZOHO_DRY_RUN;
    // Force live POST path for header inspection (test only; never deployed).
    (env as { ZOHO_SERVICE_TOKEN?: string }).ZOHO_SERVICE_TOKEN = TOKEN;
    (env as { ZOHO_SERVICE_BASE_URL?: string }).ZOHO_SERVICE_BASE_URL = 'http://svc.local:8000';
    (env as { ZOHO_DRY_RUN: boolean }).ZOHO_DRY_RUN = false;
  });
  afterEach(() => {
    (env as { ZOHO_SERVICE_TOKEN?: string }).ZOHO_SERVICE_TOKEN = savedToken;
    (env as { ZOHO_SERVICE_BASE_URL?: string }).ZOHO_SERVICE_BASE_URL = savedBase;
    (env as { ZOHO_DRY_RUN: boolean }).ZOHO_DRY_RUN = savedDry;
    vi.unstubAllGlobals();
  });

  it('authenticates with Authorization: Bearer, not X-Internal-Token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ zohoExpenseId: 'Z-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new ServiceZohoAdapter().pushExpense({
      expenseId: 'exp-123', zohoEntity: 'haute_brands', merchant: 'Acme',
      amount: '42.00', currency: 'USD', date: '2026-06-24',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers['X-Brand']).toBe(env.ZOHO_DEFAULT_BRAND);
    expect(headers).not.toHaveProperty('X-Internal-Token');
  });

  it('does not leak the token in error messages on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED 1.2.3.4'); }));
    await expect(
      new ServiceZohoAdapter().pushExpense({
        expenseId: 'exp-123', zohoEntity: 'haute_brands', merchant: 'Acme',
        amount: '42.00', currency: 'USD', date: '2026-06-24',
      })
    ).rejects.toThrow(/Zoho service request failed/);
    // And the thrown message must never contain the secret.
    try {
      await new ServiceZohoAdapter().pushExpense({
        expenseId: 'exp-123', zohoEntity: 'haute_brands', merchant: 'Acme',
        amount: '42.00', currency: 'USD', date: '2026-06-24',
      });
    } catch (e) {
      expect(String(e)).not.toContain(TOKEN);
    }
  });

  it('parses Zoho Books nested expense_id from create_books response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        data: { code: 0, message: 'ok', expense: { expense_id: '5254962000007654001' } },
      }), { status: 200 })));

    const r = await new ServiceZohoAdapter().pushExpense({
      expenseId: 'exp-123', zohoEntity: 'haute_brands', merchant: 'Acme',
      amount: '42.00', currency: 'USD', date: '2026-06-24',
    });
    expect(r.zohoExpenseId).toBe('5254962000007654001');
  });

  it('parses ZOHO_AUTH_INVALID into ZohoServiceError without leaking the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        detail: {
          error: {
            source: 'internal',
            code: 'ZOHO_AUTH_INVALID',
            message: 'Authorization required',
            request_id: 'req-abc',
          },
        },
      }), { status: 401 })));

    try {
      await new ServiceZohoAdapter().pushExpense({
        expenseId: 'exp-123', zohoEntity: 'haute_brands', merchant: 'Acme',
        amount: '42.00', currency: 'USD', date: '2026-06-24',
      });
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZohoServiceError);
      const err = e as ZohoServiceError;
      expect(err.code).toBe('ZOHO_AUTH_INVALID');
      expect(err.requestId).toBe('req-abc');
      expect(String(e)).not.toContain(TOKEN);
    }
  });
});

describe('checkZohoAuth', () => {
  let savedBase: string | undefined;
  let savedToken: string | undefined;
  beforeEach(() => {
    savedBase = env.ZOHO_SERVICE_BASE_URL;
    savedToken = env.ZOHO_SERVICE_TOKEN;
    (env as { ZOHO_SERVICE_BASE_URL?: string }).ZOHO_SERVICE_BASE_URL = 'http://svc.local:8000';
    (env as { ZOHO_SERVICE_TOKEN?: string }).ZOHO_SERVICE_TOKEN = TOKEN;
  });
  afterEach(() => {
    (env as { ZOHO_SERVICE_BASE_URL?: string }).ZOHO_SERVICE_BASE_URL = savedBase;
    (env as { ZOHO_SERVICE_TOKEN?: string }).ZOHO_SERVICE_TOKEN = savedToken;
    vi.unstubAllGlobals();
  });

  it('reports ok when organizations/list succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ organizations: [] }), { status: 200 })));
    const r = await checkZohoAuth();
    expect(r.ok).toBe(true);
  });

  it('surfaces ZOHO_AUTH_INVALID without leaking the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        detail: { error: { code: 'ZOHO_AUTH_INVALID', message: 'Authorization required', request_id: 'r1' } },
      }), { status: 401 })));
    const r = await checkZohoAuth();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ZOHO_AUTH_INVALID');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe('checkServiceHealth', () => {
  let savedBase: string | undefined;
  beforeEach(() => { savedBase = env.ZOHO_SERVICE_BASE_URL; (env as { ZOHO_SERVICE_BASE_URL?: string }).ZOHO_SERVICE_BASE_URL = 'http://svc.local:8000'; });
  afterEach(() => { (env as { ZOHO_SERVICE_BASE_URL?: string }).ZOHO_SERVICE_BASE_URL = savedBase; vi.unstubAllGlobals(); });

  it('reports reachable + version on a healthy service', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok', version: '1.28.0' }), { status: 200 })));
    const h = await checkServiceHealth();
    expect(h.reachable).toBe(true);
    expect(h.ok).toBe(true);
    expect(h.serviceVersion).toBe('1.28.0');
  });

  it('never throws and never leaks token when the service is unreachable', async () => {
    (env as { ZOHO_SERVICE_TOKEN?: string }).ZOHO_SERVICE_TOKEN = TOKEN;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    const h = await checkServiceHealth();
    expect(h.reachable).toBe(false);
    expect(h.ok).toBe(false);
    expect(JSON.stringify(h)).not.toContain(TOKEN);
  });
});

describe('mock mode', () => {
  it('default zoho adapter (ZOHO_MODE=mock in tests) does not call the service', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await zoho.pushExpense({
      expenseId: 'exp-123', zohoEntity: 'haute_brands', merchant: 'Acme',
      amount: '42.00', currency: 'USD', date: '2026-06-24',
    });
    expect(r.zohoExpenseId).toMatch(/^MOCK-ZOHO-/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
