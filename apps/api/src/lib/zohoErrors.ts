/**
 * Structured Zoho sync error categories: tells the accountant whether to
 * retry, fix data, or escalate — and tells the push loop what to auto-retry.
 *
 * Deliberately does not import lib/zoho (env-coupled); ZohoServiceError is
 * detected structurally so this stays a pure, testable module.
 */
export type ZohoErrorCategory =
  | 'AUTH_ERROR'
  | 'MAPPING_ERROR'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMIT'
  | 'NETWORK_ERROR'
  | 'ZOHO_ERROR'
  | 'DUPLICATE'
  | 'UNKNOWN';

const MAPPING_HINTS = ['account', 'entity', 'paid_through', 'paid through', 'brand'];
const NETWORK_HINTS = ['econnrefused', 'econnreset', 'etimedout', 'enotfound', 'network', 'timeout', 'fetch failed', 'socket hang up'];

interface ServiceErrorShape { name: string; status: number; code: string; message: string }

/** Zoho Books error codes are bare integers; the service's own codes are words. */
function isZohoAssignedCode(code: string): boolean {
  return /^[0-9]+$/.test(code);
}

/** Split a terminal rejection into "wrong account/entity" vs "bad field value". */
function byMessage(message: string): { category: ZohoErrorCategory; retryable: boolean } {
  const msg = message.toLowerCase();
  const isMapping = MAPPING_HINTS.some((h) => msg.includes(h));
  return { category: isMapping ? 'MAPPING_ERROR' : 'VALIDATION_ERROR', retryable: false };
}

function isServiceError(err: unknown): err is ServiceErrorShape {
  return err instanceof Error && err.name === 'ZohoServiceError'
    && typeof (err as Partial<ServiceErrorShape>).status === 'number'
    && typeof (err as Partial<ServiceErrorShape>).code === 'string';
}

export function classifyZohoError(err: unknown): { category: ZohoErrorCategory; retryable: boolean } {
  if (isServiceError(err)) {
    const code = err.code.toUpperCase();
    if (code === 'ZOHO_AUTH_INVALID' || code === 'ZOHO_AUTH_FORBIDDEN') {
      return { category: 'AUTH_ERROR', retryable: false };
    }
    if (code.includes('DUPLICATE')) return { category: 'DUPLICATE', retryable: false };
    if (err.status === 429) return { category: 'RATE_LIMIT', retryable: true };
    // A numeric code is Zoho Books' own (e.g. 1002 "invalid value for field"),
    // forwarded by the integration service — which wraps it in a 5xx. The
    // request reached Zoho and was rejected on its contents, so resending the
    // identical payload can only fail again. Classify by message and stop the
    // auto-retry, whatever HTTP status the wrapper chose.
    if (isZohoAssignedCode(code)) return byMessage(err.message);
    if (err.status >= 500) return { category: 'ZOHO_ERROR', retryable: true };
    if (err.status === 400 || err.status === 422) return byMessage(err.message);
    return { category: 'ZOHO_ERROR', retryable: false };
  }

  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (NETWORK_HINTS.some((h) => msg.includes(h))) {
    return { category: 'NETWORK_ERROR', retryable: true };
  }
  return { category: 'UNKNOWN', retryable: false };
}
