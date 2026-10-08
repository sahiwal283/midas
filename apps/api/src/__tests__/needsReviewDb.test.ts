// apps/api/src/__tests__/needsReviewDb.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const execute = vi.hoisted(() => vi.fn(async (_query: unknown) => ({ rows: [{ id: 'n-1', count: '2' }] })));
vi.mock('../db/index', () => ({ db: { execute } }));

import { bumpGroup } from '../lib/needsReviewDb';

describe('bumpGroup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a grouped row that points at no expense, so deleting one expense cannot delete it', async () => {
    const group = await bumpGroup('acc-1', 'nr:u-1:event:ev-9', { title: 'T', body: 'B' });
    expect(group).toEqual({ id: 'n-1', count: 2 });

    const { sql: text, params } = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    const flat = text.replace(/\s+/g, ' ');
    expect(params).toEqual(['acc-1', 'T', 'B', 'nr:u-1:event:ev-9']);
    expect(flat).toContain("VALUES ($1, 'needs_review', $2, $3, NULL, $4, 1)");
    expect(flat).not.toContain('expense_id = EXCLUDED.expense_id');
    // The conflict target must keep repeating the partial index's predicate.
    expect(flat).toContain('ON CONFLICT (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL');
  });
});
