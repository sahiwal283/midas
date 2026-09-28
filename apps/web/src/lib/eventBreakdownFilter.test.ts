import { describe, expect, it } from 'vitest';
import type { EventBreakdown } from '../api/reports';
import { deriveBreakdown, parseBreakdownFilter, serializeBreakdownFilter } from './eventBreakdownFilter';

type Row = EventBreakdown['expenses'][number];

function row(over: Partial<Row> & { id: string; amount: number }): Row {
  return {
    date: '2026-05-01',
    merchant: 'M',
    description: null,
    status: 'approved',
    reimbursementStatus: 'not_requested',
    zohoEntity: 'Nirvana Kulture',
    categoryName: 'Travel - Flight',
    paymentMethod: null,
    userName: null,
    ...over,
  };
}

const rows: Row[] = [
  row({ id: 'a', amount: 100, zohoEntity: 'Nirvana Kulture', categoryName: 'Travel - Flight' }),
  row({ id: 'b', amount: 50, zohoEntity: 'Summitt Labs', categoryName: 'Travel - Flight', status: 'pending' }),
  row({ id: 'c', amount: 30, zohoEntity: 'Nirvana Kulture', categoryName: 'Accommodation - Hotel' }),
  row({ id: 'd', amount: 20, zohoEntity: null, categoryName: null, status: 'zoho_sync_failed' }),
];

describe('deriveBreakdown', () => {
  it('reproduces the server aggregates when nothing is filtered', () => {
    const d = deriveBreakdown(rows, { company: null, categories: [] });
    expect(d.totals).toEqual({ spend: 200, count: 4, approved: 3, pending: 1 });
    expect(d.byEntity).toEqual([
      { name: 'Nirvana Kulture', spend: 130, count: 2 },
      { name: 'Summitt Labs', spend: 50, count: 1 },
      { name: 'Unassigned', spend: 20, count: 1 },
    ]);
    expect(d.categories).toEqual([
      { category: 'Travel - Flight', byEntity: { 'Nirvana Kulture': 100, 'Summitt Labs': 50 }, total: 150 },
      { category: 'Accommodation - Hotel', byEntity: { 'Nirvana Kulture': 30 }, total: 30 },
      { category: 'Uncategorized', byEntity: { Unassigned: 20 }, total: 20 },
    ]);
    expect(d.expenses.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('scopes every panel to one company', () => {
    const d = deriveBreakdown(rows, { company: 'Nirvana Kulture', categories: [] });
    expect(d.totals.spend).toBe(130);
    expect(d.byEntity).toEqual([{ name: 'Nirvana Kulture', spend: 130, count: 2 }]);
    expect(d.categories.map((c) => c.category)).toEqual(['Travel - Flight', 'Accommodation - Hotel']);
    expect(d.expenses.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('treats the Unassigned box as a real company filter', () => {
    const d = deriveBreakdown(rows, { company: 'Unassigned', categories: [] });
    expect(d.expenses.map((e) => e.id)).toEqual(['d']);
    expect(d.categories).toEqual([{ category: 'Uncategorized', byEntity: { Unassigned: 20 }, total: 20 }]);
  });

  it('keeps only the ticked categories and recomputes company totals from them', () => {
    const d = deriveBreakdown(rows, { company: null, categories: ['Accommodation - Hotel', 'Uncategorized'] });
    expect(d.totals).toEqual({ spend: 50, count: 2, approved: 2, pending: 0 });
    expect(d.byEntity).toEqual([
      { name: 'Nirvana Kulture', spend: 30, count: 1 },
      { name: 'Unassigned', spend: 20, count: 1 },
    ]);
    expect(d.expenses.map((e) => e.id)).toEqual(['c', 'd']);
  });

  it('composes company and category filters', () => {
    const d = deriveBreakdown(rows, { company: 'Nirvana Kulture', categories: ['Travel - Flight'] });
    expect(d.totals.spend).toBe(100);
    expect(d.expenses.map((e) => e.id)).toEqual(['a']);
  });

  it('returns an empty but well-formed result when nothing matches', () => {
    const d = deriveBreakdown(rows, { company: 'Summitt Labs', categories: ['Accommodation - Hotel'] });
    expect(d.totals).toEqual({ spend: 0, count: 0, approved: 0, pending: 0 });
    expect(d.byEntity).toEqual([]);
    expect(d.categories).toEqual([]);
    expect(d.expenses).toEqual([]);
  });
});

describe('breakdown filter ↔ URL params', () => {
  it('round-trips company and categories', () => {
    const params = new URLSearchParams();
    serializeBreakdownFilter(params, { company: 'Nirvana Kulture', categories: ['Travel - Flight', 'Meal, Entertainment'] });
    expect(params.get('company')).toBe('Nirvana Kulture');
    expect(parseBreakdownFilter(params)).toEqual({
      company: 'Nirvana Kulture',
      categories: ['Travel - Flight', 'Meal, Entertainment'],
    });
  });

  it('removes the params when the filter is empty', () => {
    const params = new URLSearchParams('show=X&company=A&cat=B');
    serializeBreakdownFilter(params, { company: null, categories: [] });
    expect(params.has('company')).toBe(false);
    expect(params.has('cat')).toBe(false);
    expect(params.get('show')).toBe('X');
  });

  it('parses an absent filter as empty', () => {
    expect(parseBreakdownFilter(new URLSearchParams('show=X'))).toEqual({ company: null, categories: [] });
  });
});
