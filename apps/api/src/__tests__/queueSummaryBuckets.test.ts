import { describe, it, expect } from 'vitest';
import { splitRowsByScope } from '../lib/queueSummaryBuckets';

const rows = [
  { sourceApp: null, amount: '10' },
  { sourceApp: 'browser_extension', amount: '20' },
  { sourceApp: 'trade_show', amount: '30' },
  { sourceApp: 'argo', amount: '40' },
];

describe('splitRowsByScope', () => {
  it('routes each row to exactly one bucket', () => {
    const { event, daily } = splitRowsByScope(rows);
    expect(daily.map((r) => r.amount)).toEqual(['10', '20']);
    expect(event.map((r) => r.amount)).toEqual(['30', '40']);
  });

  it('loses no rows — the two buckets sum to the input', () => {
    const { event, daily } = splitRowsByScope(rows);
    expect(event.length + daily.length).toBe(rows.length);
  });

  it('handles an empty input', () => {
    const { event, daily } = splitRowsByScope([]);
    expect(event).toEqual([]);
    expect(daily).toEqual([]);
  });
});
