import { describe, expect, it } from 'vitest';
import { isMalformedIdError } from '../lib/tradeShowEvents';

// No database here: only the error classification is under test. The import is
// safe DB-free because tradeShowEvents builds its pool lazily, on first query.
describe('isMalformedIdError', () => {
  it('recognises Postgres invalid_text_representation', () => {
    // What `WHERE id = 'nope'` raises against Argo's uuid `events.id` column.
    const err = Object.assign(new Error('invalid input syntax for type uuid: "nope"'), {
      code: '22P02',
    });
    expect(isMalformedIdError(err)).toBe(true);
  });

  it('does not swallow other database failures', () => {
    // A link that is down or a role without SELECT must still surface as a
    // failure, not as "no such event".
    expect(isMalformedIdError(Object.assign(new Error('permission denied'), { code: '42501' }))).toBe(false);
    expect(isMalformedIdError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe(false);
    expect(isMalformedIdError(new Error('Connection terminated'))).toBe(false);
  });

  it('handles non-error throwables', () => {
    expect(isMalformedIdError(null)).toBe(false);
    expect(isMalformedIdError(undefined)).toBe(false);
    expect(isMalformedIdError('22P02')).toBe(false);
  });
});
