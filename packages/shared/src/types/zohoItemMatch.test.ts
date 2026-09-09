import { describe, expect, it } from 'vitest';
import { matchZohoItem, ZOHO_ITEM_MATCH_THRESHOLD } from './zohoItemMatch';

const CATALOGUE = [
  { itemId: 'i1', name: 'Booth Carpet 10x10', sku: 'CARPET-1010' },
  { itemId: 'i2', name: 'Electrical Drop 500W', sku: 'ELEC-500' },
  { itemId: 'i3', name: 'Drayage Handling', sku: 'DRAY-01' },
  { itemId: 'i4', name: 'Booth Cleaning Service', sku: 'CLEAN-01' },
];

describe('matchZohoItem', () => {
  it('matches an exact name, case-insensitively', () => {
    const match = matchZohoItem('booth carpet 10x10', CATALOGUE);
    expect(match?.itemId).toBe('i1');
    expect(match?.score).toBe(1);
  });

  it('matches on SKU when the description carries it', () => {
    expect(matchZohoItem('CARPET-1010', CATALOGUE)?.itemId).toBe('i1');
  });

  it('matches a near-miss above the threshold', () => {
    const match = matchZohoItem('Booth Carpet 10x10 - grey', CATALOGUE);
    expect(match?.itemId).toBe('i1');
    expect(match!.score).toBeGreaterThanOrEqual(ZOHO_ITEM_MATCH_THRESHOLD);
  });

  it('leaves a spaced dimension string unmatched rather than guessing', () => {
    // 'Booth Carpet 10x10' tokenizes to [booth, carpet, 10x10]; the spaced form
    // tokenizes to [booth, carpet, 10, x, 10, grey] and scores 0.567 — below the
    // threshold. Unmatched is the safe answer: the user picks, and no wrong item
    // reaches a Zoho purchase order silently.
    expect(matchZohoItem('Booth carpet 10 x 10 grey', CATALOGUE)).toBeNull();
  });

  it('prefers the closer of two candidates sharing a word', () => {
    expect(matchZohoItem('Drayage handling', CATALOGUE)?.itemId).toBe('i3');
    expect(matchZohoItem('Booth cleaning', CATALOGUE)?.itemId).toBe('i4');
  });

  it('returns null when nothing clears the threshold', () => {
    expect(matchZohoItem('Forklift rental deposit', CATALOGUE)).toBeNull();
  });

  it('returns null for an empty catalogue', () => {
    expect(matchZohoItem('Booth Carpet 10x10', [])).toBeNull();
  });

  it('returns null for an empty or whitespace description', () => {
    expect(matchZohoItem('', CATALOGUE)).toBeNull();
    expect(matchZohoItem('   ', CATALOGUE)).toBeNull();
  });

  it('ignores punctuation differences', () => {
    expect(matchZohoItem('Electrical Drop, 500W.', CATALOGUE)?.itemId).toBe('i2');
  });

  it('tolerates a catalogue entry with no SKU', () => {
    const match = matchZohoItem('Booth Carpet 10x10', [
      { itemId: 'x1', name: 'Booth Carpet 10x10', sku: null },
    ]);
    expect(match?.itemId).toBe('x1');
  });

  it('never returns a score below the threshold', () => {
    const match = matchZohoItem('carpet', CATALOGUE);
    if (match) expect(match.score).toBeGreaterThanOrEqual(ZOHO_ITEM_MATCH_THRESHOLD);
  });
});
