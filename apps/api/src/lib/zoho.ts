import { env } from '../config/env';
import { logger } from './logger';
import { matchVendorByName } from './vendorMatch';
import type { ZohoServicePayload } from './zohoPayload';
import type { ZohoPoServicePayload } from './zohoPoPayload';
import { toZohoBooksPoCreateBody } from './zohoPoPayload';
import type { PostedAccounts } from './zohoAccountAudit';

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

export interface ZohoPoPushResult {
  zohoPurchaseOrderId: string;
  syncedAt: Date;
  dryRun?: boolean;
}

export interface ZohoVendor {
  vendorId: string;
  vendorName: string;
  companyName?: string | null;
}

export interface ZohoItem {
  itemId: string;
  name: string;
  sku?: string | null;
  unit?: string | null;
}

export interface ZohoAdapter {
  pushExpense(payload: ZohoPushBody): Promise<ZohoPushResult>;
  pushPurchaseOrder(payload: ZohoPoServicePayload): Promise<ZohoPoPushResult>;
  listVendors(brand: string): Promise<ZohoVendor[]>;
  createVendor(name: string, brand: string): Promise<ZohoVendor>;
  listItems(brand: string): Promise<ZohoItem[]>;
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

/**
 * Zoho Books account types offered when matching payment methods. Zoho's own
 * Paid Through picker also allows liability/asset/equity accounts, but for
 * card matching those are noise ("Goods In Transit", …) — unusual accounts can
 * still be entered by id in the payment-method editor.
 */
const PAID_THROUGH_ACCOUNT_TYPES = new Set([
  'bank',
  'credit_card',
  'cash',
]);

export interface ZohoExpenseAccount {
  accountId: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
}

async function listAccountsOfTypes(
  brand: string,
  types: ReadonlySet<string>,
  timeoutMs: number,
): Promise<ZohoExpenseAccount[]> {
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
    if (!types.has(accountType)) continue;
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

/**
 * Live chart-of-accounts for a brand, filtered to expense-class accounts
 * (matches Zoho Books "Expense Account" picker). Read-only.
 */
export async function listExpenseAccounts(brand: string, timeoutMs = 15000): Promise<ZohoExpenseAccount[]> {
  return listAccountsOfTypes(brand, EXPENSE_ACCOUNT_TYPES, timeoutMs);
}

/**
 * Live chart-of-accounts filtered to accounts usable as an expense's Paid
 * Through (bank / credit card / cash / …) — matches Zoho Books' picker.
 */
export async function listPaidThroughAccounts(brand: string, timeoutMs = 15000): Promise<ZohoExpenseAccount[]> {
  return listAccountsOfTypes(brand, PAID_THROUGH_ACCOUNT_TYPES, timeoutMs);
}

/**
 * Resolve the merchant to a Zoho Books vendor (contact) id: exact name match
 * against the brand's vendor list, else create a vendor contact. Best-effort —
 * any failure returns null and the push proceeds without a vendor rather than
 * blocking the expense.
 */
export async function resolveBooksVendorId(merchant: string, brand: string): Promise<string | null> {
  if (env.ZOHO_MODE !== 'service' || env.ZOHO_DRY_RUN) return null;
  if (!env.ZOHO_SERVICE_BASE_URL || !env.ZOHO_SERVICE_TOKEN || !merchant.trim()) return null;

  try {
    const list = await zoho.listVendors(brand);
    const matched = matchVendorByName(
      list.map((v) => ({ id: v.vendorId, name: v.companyName || v.vendorName })),
      merchant,
    );
    if (matched) return matched;

    const created = await zoho.createVendor(merchant.trim(), brand);
    return created.vendorId;
  } catch (err) {
    logger.warn({ err, merchant, brand }, 'Zoho vendor resolution failed — pushing without vendor');
    return null;
  }
}

/**
 * Read back the accounts Zoho actually stored on a Books expense, so the push
 * can verify they match what Midas sent (see zohoAccountAudit). Best-effort:
 * any failure returns null, which the audit treats as "cannot tell".
 */
export async function fetchBooksExpenseAccounts(
  zohoExpenseId: string,
  brand: string,
): Promise<PostedAccounts | null> {
  const baseUrl = env.ZOHO_SERVICE_BASE_URL;
  if (env.ZOHO_MODE !== 'service' || env.ZOHO_DRY_RUN) return null;
  if (!baseUrl || !env.ZOHO_SERVICE_TOKEN) return null;

  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/zoho/expenses/get_books/${encodeURIComponent(zohoExpenseId)}`,
      { method: 'GET', headers: serviceHeaders({}, brand) },
      15000,
    );
    if (!res.ok) {
      logger.warn({ zohoExpenseId, brand, status: res.status }, 'Zoho expense readback failed');
      return null;
    }
    const data = await res.json() as {
      expense?: Record<string, unknown>;
      data?: { expense?: Record<string, unknown> } & Record<string, unknown>;
    } & Record<string, unknown>;
    const record = data.data?.expense ?? data.expense ?? data.data ?? data;
    const read = (key: string): string | null => {
      const value = (record as Record<string, unknown>)[key];
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };
    return {
      accountId: read('account_id'),
      paidThroughAccountId: read('paid_through_account_id'),
    };
  } catch (err) {
    logger.warn({ err, zohoExpenseId, brand }, 'Zoho expense readback failed');
    return null;
  }
}

/**
 * Attach a receipt file to an existing Zoho Books expense. Best-effort: the
 * expense already exists in Zoho, so a failed attachment logs and returns
 * false instead of failing the push.
 */
export async function attachReceiptToBooksExpense(
  zohoExpenseId: string,
  file: { buffer: Buffer; filename: string; mimeType: string },
  brand: string,
): Promise<boolean> {
  if (env.ZOHO_MODE !== 'service' || env.ZOHO_DRY_RUN) return false;
  const baseUrl = env.ZOHO_SERVICE_BASE_URL;
  if (!baseUrl || !env.ZOHO_SERVICE_TOKEN) return false;

  try {
    const form = new FormData();
    // Zoho Books' POST /expenses/{id}/receipt requires the field name `receipt`
    // (the integration service forwards multipart field names verbatim).
    form.append('receipt', new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }), file.filename);
    const res = await fetchWithTimeout(
      `${baseUrl}/zoho/expenses/attach_receipt/${encodeURIComponent(zohoExpenseId)}`,
      // No explicit Content-Type: fetch sets the multipart boundary itself.
      { method: 'POST', headers: serviceHeaders({}, brand), body: form },
      30000,
    );
    if (!res.ok) {
      logger.warn({ zohoExpenseId, brand, status: res.status }, 'Zoho receipt attach failed');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, zohoExpenseId, brand }, 'Zoho receipt attach failed');
    return false;
  }
}

/** Wire shape for create_books — only fields the integration service / Zoho Books accept. */
export function toCreateBooksBody(payload: ZohoPushBody): Record<string, unknown> {
  const p = payload as ZohoServicePayload & ZohoPushPayload;
  // The service drops `merchant` when creating the Books record (no vendor
  // mapping), which left expenses unsearchable in Zoho. Bake the merchant into
  // the description so the record always carries it.
  const merchant = p.merchant?.trim() ?? '';
  const notes = p.description?.trim() || null;
  const description = notes
    ? (merchant && !notes.toLowerCase().startsWith(merchant.toLowerCase()) ? `${merchant} — ${notes}` : notes)
    : merchant || null;
  const referenceNumber = typeof p.reference_number === 'string' ? p.reference_number.trim() : '';
  return {
    idempotencyKey: 'idempotencyKey' in p ? p.idempotencyKey : undefined,
    expenseId: 'expenseId' in p ? p.expenseId : undefined,
    merchant: p.merchant,
    amount: p.amount,
    currency: p.currency,
    date: p.date,
    description,
    zohoEntity: p.zohoEntity,
    brand: 'brand' in p ? p.brand : env.ZOHO_DEFAULT_BRAND,
    account_id: 'account_id' in p ? p.account_id : undefined,
    paid_through_account_id: 'paid_through_account_id' in p ? p.paid_through_account_id : undefined,
    vendor_id: 'vendor_id' in p ? (p.vendor_id ?? undefined) : undefined,
    reimbursable: 'reimbursable' in p ? p.reimbursable : undefined,
    ...(referenceNumber ? { reference_number: referenceNumber } : {}),
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

  async pushPurchaseOrder(payload: ZohoPoServicePayload): Promise<ZohoPoPushResult> {
    logger.debug({ payload }, 'Zoho mock: would push purchase order to Zoho');
    return {
      zohoPurchaseOrderId: `MOCK-ZOHO-PO-${Date.now()}`,
      syncedAt: new Date(),
    };
  }

  async listVendors(_brand: string): Promise<ZohoVendor[]> {
    return [
      { vendorId: 'MOCK-V-1', vendorName: 'ABC Food Supply' },
      { vendorId: 'MOCK-V-2', vendorName: 'Demo Ingredients Co' },
    ];
  }

  async createVendor(name: string, _brand: string): Promise<ZohoVendor> {
    return { vendorId: `MOCK-V-${Date.now()}`, vendorName: name };
  }

  async listItems(_brand: string): Promise<ZohoItem[]> {
    return [
      { itemId: 'MOCK-I-1', name: 'Mini Marshmallows', unit: 'bag', sku: 'MM-5LB' },
      { itemId: 'MOCK-I-2', name: 'Butter', unit: 'case', sku: 'BUT-CS' },
    ];
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
      const errBody = await res.text();
      throw parseServiceErrorBody(errBody, res.status);
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

  async pushPurchaseOrder(payload: ZohoPoServicePayload): Promise<ZohoPoPushResult> {
    const baseUrl = env.ZOHO_SERVICE_BASE_URL;
    if (!baseUrl) throw new Error('ZOHO_SERVICE_BASE_URL is not configured');
    if (!env.ZOHO_SERVICE_TOKEN) throw new Error('ZOHO_SERVICE_TOKEN is not configured');

    if (env.ZOHO_DRY_RUN) {
      logger.info({ payload, brand: payload.brand }, 'Zoho dry-run: skipping live PO POST to integration service');
      return {
        zohoPurchaseOrderId: `DRY-RUN-PO-${Date.now()}`,
        syncedAt: new Date(),
        dryRun: true,
      };
    }

    // Books wire shape only — never forward nested camelCase provenance/lineItems.
    const body = toZohoBooksPoCreateBody(payload);

    let res: Response;
    try {
      res = await fetchWithTimeout(`${baseUrl}/zoho/purchaseorders/create`, {
        method: 'POST',
        headers: serviceHeaders({ 'Content-Type': 'application/json' }, payload.brand),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Zoho service PO request failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    if (!res.ok) {
      const errBody = await res.text();
      throw parseServiceErrorBody(errBody, res.status);
    }
    const data = await res.json() as {
      zohoPurchaseOrderId?: string;
      purchaseorder_id?: string;
      id?: string;
      data?: {
        purchaseorder?: { purchaseorder_id?: string };
        purchaseorder_id?: string;
      };
    };
    const zohoPurchaseOrderId =
      data.zohoPurchaseOrderId
      ?? data.purchaseorder_id
      ?? data.data?.purchaseorder?.purchaseorder_id
      ?? data.data?.purchaseorder_id
      ?? data.id;
    if (!zohoPurchaseOrderId) {
      throw new ZohoServiceError({
        status: res.status,
        code: 'ZOHO_RESPONSE_INVALID',
        message: 'Zoho service response missing purchaseorder_id',
      });
    }
    return { zohoPurchaseOrderId, syncedAt: new Date() };
  }

  async listVendors(brand: string): Promise<ZohoVendor[]> {
    const baseUrl = env.ZOHO_SERVICE_BASE_URL;
    if (!baseUrl) throw new Error('ZOHO_SERVICE_BASE_URL is not configured');
    if (!env.ZOHO_SERVICE_TOKEN) throw new Error('ZOHO_SERVICE_TOKEN is not configured');

    const res = await fetchWithTimeout(
      `${baseUrl}/zoho/vendors/list`,
      { method: 'GET', headers: serviceHeaders({}, brand) },
      15000,
    );
    if (!res.ok) {
      const errBody = await res.text();
      throw parseServiceErrorBody(errBody, res.status);
    }
    const data = await res.json() as {
      vendors?: Array<Record<string, unknown>>;
      contacts?: Array<Record<string, unknown>>;
      data?: {
        vendors?: Array<Record<string, unknown>>;
        contacts?: Array<Record<string, unknown>>;
      };
    };
    const rows = data.vendors ?? data.contacts ?? data.data?.vendors ?? data.data?.contacts ?? [];
    return rows.map((v) => ({
      vendorId: String(v.vendorId ?? v.vendor_id ?? v.contact_id ?? ''),
      vendorName: String(v.vendorName ?? v.vendor_name ?? v.contact_name ?? v.company_name ?? ''),
      companyName: (v.company_name as string | undefined) ?? null,
    })).filter((v) => v.vendorId && v.vendorName);
  }

  async createVendor(name: string, brand: string): Promise<ZohoVendor> {
    const baseUrl = env.ZOHO_SERVICE_BASE_URL;
    if (!baseUrl) throw new Error('ZOHO_SERVICE_BASE_URL is not configured');
    if (!env.ZOHO_SERVICE_TOKEN) throw new Error('ZOHO_SERVICE_TOKEN is not configured');

    // vendors/create maps to Books POST /contacts (vendor-type contact).
    const res = await fetchWithTimeout(
      `${baseUrl}/zoho/vendors/create`,
      {
        method: 'POST',
        headers: serviceHeaders({ 'Content-Type': 'application/json' }, brand),
        body: JSON.stringify({ contact_name: name, contact_type: 'vendor' }),
      },
      15000,
    );
    if (!res.ok) {
      const errBody = await res.text();
      throw parseServiceErrorBody(errBody, res.status);
    }
    const data = await res.json() as {
      data?: { contact?: { contact_id?: string; contact_name?: string } };
      contact?: { contact_id?: string; contact_name?: string };
    };
    const contact = data.data?.contact ?? data.contact;
    if (!contact?.contact_id) {
      throw new ZohoServiceError({
        status: 502,
        code: 'ZOHO_RESPONSE_INVALID',
        message: 'Zoho service response missing contact_id for created vendor',
      });
    }
    return { vendorId: contact.contact_id, vendorName: contact.contact_name ?? name };
  }

  async listItems(brand: string): Promise<ZohoItem[]> {
    const baseUrl = env.ZOHO_SERVICE_BASE_URL;
    if (!baseUrl) throw new Error('ZOHO_SERVICE_BASE_URL is not configured');
    if (!env.ZOHO_SERVICE_TOKEN) throw new Error('ZOHO_SERVICE_TOKEN is not configured');

    const res = await fetchWithTimeout(
      `${baseUrl}/zoho/items/list`,
      { method: 'GET', headers: serviceHeaders({}, brand) },
      15000,
    );
    if (!res.ok) {
      const errBody = await res.text();
      throw parseServiceErrorBody(errBody, res.status);
    }
    const data = await res.json() as {
      items?: Array<Record<string, unknown>>;
      data?: { items?: Array<Record<string, unknown>> };
    };
    const rows = data.items ?? data.data?.items ?? [];
    return rows.map((i) => ({
      itemId: String(i.itemId ?? i.item_id ?? ''),
      name: String(i.name ?? i.item_name ?? ''),
      sku: (i.sku as string | undefined) ?? null,
      unit: (i.unit as string | undefined) ?? null,
    })).filter((i) => i.itemId && i.name);
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
