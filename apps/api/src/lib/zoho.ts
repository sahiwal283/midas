import { env } from '../config/env';
import { logger } from './logger';
import type { ZohoServicePayload } from './zohoPayload';

/** Thin legacy shape still accepted by mock/tests; service push prefers ZohoServicePayload. */
export interface ZohoPushPayload {
  expenseId: string;
  zohoEntity: string;
  merchant: string;
  amount: string;
  currency: string;
  date: string;
  description?: string | null;
  receiptPath?: string;
}

export type ZohoPushBody = ZohoPushPayload | ZohoServicePayload;

export interface ZohoPushResult {
  zohoExpenseId: string;
  syncedAt: Date;
  dryRun?: boolean;
}

export interface ZohoAdapter {
  pushExpense(payload: ZohoPushBody): Promise<ZohoPushResult>;
}

/** Structured error from the Zoho Integration Service (never includes the app token). */
export class ZohoServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(opts: { status: number; code: string; message: string; requestId?: string | null }) {
    super(opts.message);
    this.name = 'ZohoServiceError';
    this.status = opts.status;
    this.code = opts.code;
    this.requestId = opts.requestId ?? null;
  }
}

// Result of a connectivity probe against the Zoho Integration Service.
// Never includes the app token or any secret.
export interface ZohoServiceHealth {
  reachable: boolean;
  ok: boolean;
  baseUrl: string | null;
  status?: number;
  serviceVersion?: string | null;
  detail?: string | null;
}

/** Read-only probe: can the service call Zoho for our brand? Never creates records. */
export interface ZohoAuthProbe {
  ok: boolean;
  status?: number;
  code?: string | null;
  message?: string | null;
  requestId?: string | null;
}

const DEFAULT_TIMEOUT_MS = 8000;

// fetch with an explicit timeout. Midas must never hang on the integration service.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Per-app credential goes in Authorization: Bearer. X-Brand scopes the Zoho org.
// Do NOT put ZOHO_SERVICE_TOKEN in X-Internal-Token — that header is the service's
// shared INTERNAL_API_TOKEN only; using the app secret there yields ZOHO_AUTH_INVALID
// before any Zoho OAuth path runs. The token is NEVER logged or returned.
function serviceHeaders(extra: Record<string, string> = {}, brand?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Brand': brand ?? env.ZOHO_DEFAULT_BRAND,
    ...extra,
  };
  if (env.ZOHO_SERVICE_TOKEN) headers['Authorization'] = `Bearer ${env.ZOHO_SERVICE_TOKEN}`;
  return headers;
}

/** Zoho Books account types that appear in the Expense Account dropdown. */
const EXPENSE_ACCOUNT_TYPES = new Set([
  'expense',
  'other_expense',
  'cost_of_goods_sold',
]);

export interface ZohoExpenseAccount {
  accountId: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
}

/**
 * Live chart-of-accounts for a brand, filtered to expense-class accounts
 * (matches Zoho Books "Expense Account" picker). Read-only.
 */
export async function listExpenseAccounts(brand: string, timeoutMs = 15000): Promise<ZohoExpenseAccount[]> {
  const baseUrl = env.ZOHO_SERVICE_BASE_URL;
  if (!baseUrl) throw new Error('ZOHO_SERVICE_BASE_URL is not configured');
  if (!env.ZOHO_SERVICE_TOKEN) throw new Error('ZOHO_SERVICE_TOKEN is not configured');

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${baseUrl}/zoho/chartofaccounts/list`,
      { method: 'GET', headers: serviceHeaders({}, brand) },
      timeoutMs,
    );
  } catch (err) {
    throw new Error(`Zoho service request failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw parseServiceErrorBody(body, res.status);
  }
  const json = await res.json() as {
    data?: { chartofaccounts?: Array<Record<string, unknown>> };
    chartofaccounts?: Array<Record<string, unknown>>;
  };
  const raw = json.data?.chartofaccounts ?? json.chartofaccounts ?? [];
  const accounts: ZohoExpenseAccount[] = [];
  for (const a of raw) {
    const accountType = String(a.account_type ?? '');
    if (!EXPENSE_ACCOUNT_TYPES.has(accountType)) continue;
    if (a.is_active === false) continue;
    const accountId = String(a.account_id ?? '');
    const accountName = String(a.account_name ?? '');
    if (!accountId || !accountName) continue;
    accounts.push({
      accountId,
      accountName,
      accountCode: a.account_code != null && String(a.account_code) !== '' ? String(a.account_code) : null,
      accountType,
    });
  }
  accounts.sort((a, b) => {
    if (a.accountType !== b.accountType) return a.accountType.localeCompare(b.accountType);
    return a.accountName.localeCompare(b.accountName);
  });
  return accounts;
}

/** Wire shape for create_books — only fields the integration service / Zoho Books accept. */
export function toCreateBooksBody(payload: ZohoPushBody): Record<string, unknown> {
  const p = payload as ZohoServicePayload & ZohoPushPayload;
  return {
    idempotencyKey: 'idempotencyKey' in p ? p.idempotencyKey : undefined,
    expenseId: 'expenseId' in p ? p.expenseId : undefined,
    merchant: p.merchant,
    amount: p.amount,
    currency: p.currency,
    date: p.date,
    description: p.description ?? null,
    zohoEntity: p.zohoEntity,
    brand: 'brand' in p ? p.brand : env.ZOHO_DEFAULT_BRAND,
    account_id: 'account_id' in p ? p.account_id : undefined,
    paid_through_account_id: 'paid_through_account_id' in p ? p.paid_through_account_id : undefined,
    reimbursable: 'reimbursable' in p ? p.reimbursable : undefined,
    // Do not send nested `source`, `category`, or `paymentMethod` — Zoho Books treats
    // `source` as a short string field and rejects our provenance object.
  };
}

function parseServiceErrorBody(body: string, status: number): ZohoServiceError {
  try {
    const parsed = JSON.parse(body) as {
      detail?: { error?: { code?: string; message?: string; request_id?: string } };
      error?: { code?: string; message?: string; request_id?: string };
    };
    const err = parsed.detail?.error ?? parsed.error;
    if (err?.code) {
      return new ZohoServiceError({
        status,
        code: err.code,
        message: err.message ?? err.code,
        requestId: err.request_id ?? null,
      });
    }
  } catch { /* non-JSON */ }
  return new ZohoServiceError({
    status,
    code: 'ZOHO_SERVICE_ERROR',
    message: `Zoho service returned ${status}`,
  });
}

// Mock adapter — no external calls. Logs + returns fake Zoho ID.
class MockZohoAdapter implements ZohoAdapter {
  async pushExpense(payload: ZohoPushBody): Promise<ZohoPushResult> {
    logger.debug({ payload }, 'Zoho mock: would push expense to Zoho');
    return {
      zohoExpenseId: `MOCK-ZOHO-${Date.now()}`,
      syncedAt: new Date(),
    };
  }
}

// Service adapter — calls the shared Zoho Integration Service.
// Never implement Zoho OAuth inside Midas; that belongs in the integration service.
// Exported for unit testing of header/auth behavior.
export class ServiceZohoAdapter implements ZohoAdapter {
  async pushExpense(payload: ZohoPushBody): Promise<ZohoPushResult> {
    const baseUrl = env.ZOHO_SERVICE_BASE_URL;
    if (!baseUrl) throw new Error('ZOHO_SERVICE_BASE_URL is not configured');
    if (!env.ZOHO_SERVICE_TOKEN) throw new Error('ZOHO_SERVICE_TOKEN is not configured');

    if (env.ZOHO_DRY_RUN) {
      logger.info({ payload, brand: env.ZOHO_DEFAULT_BRAND }, 'Zoho dry-run: skipping live POST to integration service');
      return {
        zohoExpenseId: `DRY-RUN-${Date.now()}`,
        syncedAt: new Date(),
        dryRun: true,
      };
    }

    // Zoho Books has a string field named `source` (max 100 chars). Never forward our
    // nested provenance object under that key — it triggers ZOHO validation error 15.
    const body = toCreateBooksBody(payload);
    const brand = typeof body.brand === 'string' ? body.brand : env.ZOHO_DEFAULT_BRAND;

    let res: Response;
    try {
      res = await fetchWithTimeout(`${baseUrl}/zoho/expenses/create_books`, {
        method: 'POST',
        headers: serviceHeaders({ 'Content-Type': 'application/json' }, brand),
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network/timeout/abort — never leak headers (token) into the error.
      throw new Error(`Zoho service request failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    if (!res.ok) {
      const body = await res.text();
      throw parseServiceErrorBody(body, res.status);
    }
    const data = await res.json() as {
      zohoExpenseId?: string;
      id?: string;
      expense_id?: string;
      data?: { expense?: { expense_id?: string }; expense_id?: string };
      expense?: { expense_id?: string };
    };
    // Integration service wraps Zoho Books: { data: { expense: { expense_id } } }.
    const zohoExpenseId =
      data.zohoExpenseId
      ?? data.expense_id
      ?? data.data?.expense?.expense_id
      ?? data.data?.expense_id
      ?? data.expense?.expense_id
      ?? data.id;
    if (!zohoExpenseId) {
      throw new ZohoServiceError({
        status: res.status,
        code: 'ZOHO_RESPONSE_INVALID',
        message: 'Zoho service response missing expense_id',
      });
    }
    return { zohoExpenseId, syncedAt: new Date() };
  }
}

// Connectivity/health probe for the integration service. Read-only, safe to call in any
// ZOHO_MODE (it never touches Zoho — only the service's own /health). Returns a normalized
// result and never throws; the token is never included in the result.
export async function checkServiceHealth(timeoutMs = 5000): Promise<ZohoServiceHealth> {
  const baseUrl = env.ZOHO_SERVICE_BASE_URL ?? null;
  if (!baseUrl) {
    return { reachable: false, ok: false, baseUrl: null, detail: 'ZOHO_SERVICE_BASE_URL is not configured' };
  }
  try {
    const res = await fetchWithTimeout(`${baseUrl}/health`, { method: 'GET', headers: serviceHeaders() }, timeoutMs);
    let serviceVersion: string | null = null;
    let detail: string | null = null;
    try {
      const body = await res.json() as { version?: string; status?: string };
      serviceVersion = body.version ?? null;
      detail = body.status ?? null;
    } catch { /* non-JSON health body is non-fatal */ }
    return { reachable: true, ok: res.ok, baseUrl, status: res.status, serviceVersion, detail };
  } catch (err) {
    // Sanitize: only the error message text, which never contains the token.
    return { reachable: false, ok: false, baseUrl, detail: err instanceof Error ? err.message : 'unknown error' };
  }
}

/**
 * Probes whether the integration service can authorize against Zoho for ZOHO_DEFAULT_BRAND.
 * Uses GET /zoho/organizations/list (read-only). Never creates Zoho records.
 */
export async function checkZohoAuth(timeoutMs = 8000): Promise<ZohoAuthProbe> {
  const baseUrl = env.ZOHO_SERVICE_BASE_URL;
  if (!baseUrl) {
    return { ok: false, code: 'NOT_CONFIGURED', message: 'ZOHO_SERVICE_BASE_URL is not configured' };
  }
  if (!env.ZOHO_SERVICE_TOKEN) {
    return { ok: false, code: 'NOT_CONFIGURED', message: 'ZOHO_SERVICE_TOKEN is not configured' };
  }
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/zoho/organizations/list`,
      { method: 'GET', headers: serviceHeaders() },
      timeoutMs,
    );
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    const body = await res.text();
    const parsed = parseServiceErrorBody(body, res.status);
    return {
      ok: false,
      status: res.status,
      code: parsed.code,
      message: parsed.message,
      requestId: parsed.requestId,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      message: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

export const zoho: ZohoAdapter =
  env.ZOHO_MODE === 'service' ? new ServiceZohoAdapter() : new MockZohoAdapter();
