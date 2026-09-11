import { describe, expect, it } from 'vitest';
import { isBatchedUpload } from '../lib/batchFlag';

describe('isBatchedUpload', () => {
  it('treats "1" and "true" as batched, matching the async flag', () => {
    expect(isBatchedUpload('1')).toBe(true);
    expect(isBatchedUpload('true')).toBe(true);
  });

  it('defaults to not-batched when the flag is absent', () => {
    // The default must preserve today's behaviour exactly: a lone upload runs
    // the auto-push check. Every existing caller omits this parameter.
    expect(isBatchedUpload(undefined)).toBe(false);
  });

  it('is not batched for explicit falsey values', () => {
    expect(isBatchedUpload('0')).toBe(false);
    expect(isBatchedUpload('false')).toBe(false);
    expect(isBatchedUpload('')).toBe(false);
  });

  it('ignores values it does not recognise rather than guessing', () => {
    expect(isBatchedUpload('yes')).toBe(false);
    expect(isBatchedUpload(['1'])).toBe(false);
    expect(isBatchedUpload(null)).toBe(false);
  });
});
