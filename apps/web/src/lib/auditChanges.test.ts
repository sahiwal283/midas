import { describe, it, expect } from 'vitest';
import { auditChanges, auditActionLabel, auditMidasOnly, latestNoteEdit } from './auditChanges';

describe('auditChanges', () => {
  it('lists one line per corrected field with the readable label and both values', () => {
    const lines = auditChanges({
      action: 'details.corrected',
      before: { description: 'mop sink', amount: '169.90' },
      after: { description: 'mop sink for the warehouse', amount: '170.00' },
      metadata: null,
    });
    expect(lines).toEqual([
      { field: 'Notes', before: 'mop sink', after: 'mop sink for the warehouse' },
      { field: 'Amount', before: '169.90', after: '170.00' },
    ]);
  });

  it('shows a cleared note as empty rather than the word null', () => {
    const lines = auditChanges({
      action: 'details.corrected',
      before: { description: 'mop sink' },
      after: { description: null },
      metadata: null,
    });
    expect(lines).toEqual([{ field: 'Notes', before: 'mop sink', after: '' }]);
  });

  it('skips the internal columns a company change drags along', () => {
    const lines = auditChanges({
      action: 'details.corrected',
      before: { zohoEntity: 'Haute Brands' },
      after: { zohoEntity: 'Boomin Brands', zohoExpenseAccountId: '123', zohoExpenseAccountName: 'Equipment' },
      metadata: null,
    });
    expect(lines).toEqual([{ field: 'Company', before: 'Haute Brands', after: 'Boomin Brands' }]);
  });

  it('returns nothing for an entry whose before and after are not flat objects', () => {
    expect(auditChanges({ action: 'review.approve', before: null, after: null, metadata: null })).toEqual([]);
    expect(auditChanges({ action: 'uploaded', before: null, after: 'file.png', metadata: null })).toEqual([]);
  });

  it('labels the correction actions the trail used to show raw', () => {
    expect(auditActionLabel('details.corrected')).toBe('Details corrected');
    expect(auditActionLabel('reference_number.set')).toBe('Reference number set');
    expect(auditActionLabel('something.new')).toBe('something.new');
  });
});

describe('auditMidasOnly', () => {
  it('is true only for an entry the API tagged as a post-push, Midas-only change', () => {
    expect(auditMidasOnly({ action: 'details.corrected', before: {}, after: {}, metadata: { midasOnly: true } })).toBe(true);
    expect(auditMidasOnly({ action: 'details.corrected', before: {}, after: {}, metadata: null })).toBe(false);
  });
});

describe('latestNoteEdit', () => {
  const at = (iso: string, action: string, after: unknown, actorName = 'Pat') =>
    ({ id: iso, action, before: {}, after, metadata: null, createdAt: iso, actorId: 'u1', actorName, actorRole: 'accountant' });

  it('returns who last changed the notes and when, from a newest-first trail', () => {
    const entries = [
      at('2026-10-05T10:00:00Z', 'details.corrected', { amount: '170.00' }),
      at('2026-10-04T10:00:00Z', 'details.corrected', { description: 'mop sink for the warehouse' }, 'Sam'),
      at('2026-10-01T10:00:00Z', 'updated', { description: 'mop sink' }, 'Seri'),
    ];
    expect(latestNoteEdit(entries)).toEqual({ actorName: 'Sam', createdAt: '2026-10-04T10:00:00Z' });
  });

  it('ignores an owner edit that rewrote the row but left the notes alone', () => {
    const entry = {
      ...at('2026-10-02T10:00:00Z', 'updated', { description: 'mop sink', amount: '170.00' }, 'Seri'),
      before: { description: 'mop sink', amount: '169.90' },
    };
    expect(latestNoteEdit([entry])).toBeNull();
  });

  it('returns null when the notes were never edited', () => {
    expect(latestNoteEdit([at('2026-10-05T10:00:00Z', 'review.approve', null)])).toBeNull();
    expect(latestNoteEdit([])).toBeNull();
  });
});
