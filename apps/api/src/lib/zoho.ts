import { env } from '../config/env';
import { logger } from './logger';

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

export interface ZohoPushResult {
  zohoExpenseId: string;
  syncedAt: Date;
  dryRun?: boolean;
}

export interface ZohoAdapter {
  pushExpense(payload: ZohoPushPayload): Promise<ZohoPushResult>;
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

// The integration service authenticates apps with the X-Internal-Token header and
// scopes Zoho org access with X-Brand. The token is NEVER logged or returned.
function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { 'X-Brand': env.ZOHO_DEFAULT_BRAND, ...extra };
  if (env.ZOHO_SERVICE_TOKEN) headers['X-Internal-Token'] = env.ZOHO_SERVICE_TOKEN;
  return headers;
}

// Mock adapter — no external calls. Logs + returns fake Zoho ID.
class MockZohoAdapter implements ZohoAdapter {
  async pushExpense(payload: ZohoPushPayload): Promise<ZohoPushResult> {
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
  async pushExpense(payload: ZohoPushPayload): Promise<ZohoPushResult> {
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

    let res: Response;
    try {
      res = await fetchWithTimeout(`${baseUrl}/zoho/expenses/create_books`, {
        method: 'POST',
        headers: serviceHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Network/timeout/abort — never leak headers (token) into the error.
      throw new Error(`Zoho service request failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Zoho service returned ${res.status}: ${body}`);
    }
    const data = await res.json() as { zohoExpenseId: string };
    return { zohoExpenseId: data.zohoExpenseId, syncedAt: new Date() };
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

export const zoho: ZohoAdapter =
  env.ZOHO_MODE === 'service' ? new ServiceZohoAdapter() : new MockZohoAdapter();
