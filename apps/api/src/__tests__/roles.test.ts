import { describe, expect, it } from 'vitest';
import { roleAllowed } from '../lib/roles';

describe('roleAllowed', () => {
  it('allows a listed role', () => {
    expect(roleAllowed('partner', ['partner'])).toBe(true);
  });

  it('rejects an unlisted role', () => {
    expect(roleAllowed('user', ['partner'])).toBe(false);
    expect(roleAllowed('admin', ['partner'])).toBe(false);
  });

  it('developer passes every gate', () => {
    expect(roleAllowed('developer', ['partner'])).toBe(true);
    expect(roleAllowed('developer', ['admin'])).toBe(true);
    expect(roleAllowed('developer', ['accountant', 'admin'])).toBe(true);
  });
});
