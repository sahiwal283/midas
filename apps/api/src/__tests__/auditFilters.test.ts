import { describe, expect, it } from 'vitest';
import { parseAuditFilters } from '../lib/auditFilters';

const UUID = '2b2f4f1e-9c1d-4b7e-9a1a-0f3b4c5d6e7f';

describe('parseAuditFilters', () => {
  it('defaults to page 1, pageSize 50 with no filters', () => {
    expect(parseAuditFilters({})).toEqual({ page: 1, pageSize: 50 });
  });

  it('accepts all supported filters', () => {
    const f = parseAuditFilters({
      entityType: 'user',
      action: 'admin.user',
      userId: UUID,
      entityId: 'abc-123',
      from: '2026-01-01',
      to: '2026-01-31',
      search: 'deactivated',
      page: '3',
      pageSize: '25',
    });
    expect(f).toEqual({
      entityType: 'user',
      action: 'admin.user',
      userId: UUID,
      entityId: 'abc-123',
      from: '2026-01-01',
      to: '2026-01-31',
      search: 'deactivated',
      page: 3,
      pageSize: 25,
    });
  });

  it('trims whitespace and drops blank strings', () => {
    const f = parseAuditFilters({ entityType: '  user ', action: '  ', search: '' });
    expect(f).toEqual({ entityType: 'user', page: 1, pageSize: 50 });
  });

  it('rejects malformed userId and dates', () => {
    const f = parseAuditFilters({ userId: 'not-a-uuid', from: '01/01/2026', to: '2026-1-1' });
    expect(f).toEqual({ page: 1, pageSize: 50 });
  });

  it('clamps pageSize to 100 and ignores invalid paging values', () => {
    expect(parseAuditFilters({ pageSize: '500' }).pageSize).toBe(100);
    expect(parseAuditFilters({ pageSize: '0' }).pageSize).toBe(50);
    expect(parseAuditFilters({ page: '-2' }).page).toBe(1);
    expect(parseAuditFilters({ page: 'abc', pageSize: 'abc' })).toEqual({ page: 1, pageSize: 50 });
  });
});
