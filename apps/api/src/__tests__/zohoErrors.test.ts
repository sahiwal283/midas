import { describe, expect, it } from 'vitest';
import { classifyZohoError } from '../lib/zohoErrors';

// Structural stand-in for lib/zoho's ZohoServiceError (that module is
// env-coupled and can't be imported in unit tests).
function svcErr(status: number, code: string, message = 'boom') {
  const err = new Error(message) as Error & { status: number; code: string };
  err.name = 'ZohoServiceError';
  err.status = status;
  err.code = code;
  return err;
}

describe('classifyZohoError', () => {
  it('auth errors are not auto-retryable', () => {
    expect(classifyZohoError(svcErr(401, 'ZOHO_AUTH_INVALID'))).toEqual({ category: 'AUTH_ERROR', retryable: false });
    expect(classifyZohoError(svcErr(403, 'ZOHO_AUTH_FORBIDDEN'))).toEqual({ category: 'AUTH_ERROR', retryable: false });
  });

  it('429 → RATE_LIMIT retryable; 5xx → ZOHO_ERROR retryable', () => {
    expect(classifyZohoError(svcErr(429, 'RATE'))).toEqual({ category: 'RATE_LIMIT', retryable: true });
    expect(classifyZohoError(svcErr(502, 'UPSTREAM'))).toEqual({ category: 'ZOHO_ERROR', retryable: true });
  });

  it('duplicates are terminal', () => {
    expect(classifyZohoError(svcErr(409, 'ZOHO_DUPLICATE'))).toEqual({ category: 'DUPLICATE', retryable: false });
  });

  it('400/422 split mapping vs validation by message', () => {
    expect(classifyZohoError(svcErr(400, 'BAD', 'Invalid paid_through account id'))).toEqual({ category: 'MAPPING_ERROR', retryable: false });
    expect(classifyZohoError(svcErr(422, 'BAD', 'amount must be positive'))).toEqual({ category: 'VALIDATION_ERROR', retryable: false });
  });

  it('plain network failures are NETWORK_ERROR retryable', () => {
    expect(classifyZohoError(new Error('connect ECONNREFUSED 192.168.1.205:8000'))).toEqual({ category: 'NETWORK_ERROR', retryable: true });
    expect(classifyZohoError(new Error('request timeout'))).toEqual({ category: 'NETWORK_ERROR', retryable: true });
  });

  it('everything else is UNKNOWN, not retryable', () => {
    expect(classifyZohoError(new Error('weird'))).toEqual({ category: 'UNKNOWN', retryable: false });
  });
});
