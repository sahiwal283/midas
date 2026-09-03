import { describe, it, expect } from 'vitest';
import { planAccountantDetailsEdit, type DetailsEditTarget } from '../lib/accountantDetailsEdit';

const base: DetailsEditTarget = {
  merchant: 'Summitt labs',
  amount: '948.00',
  date: '2026-05-05',
  paymentMethodId: null,
  description: null,
  zohoExpenseId: null,
  sourceApp: null,
  sourceRefId: null,
  sourceContext: {},
};

describe('planAccountantDetailsEdit', () => {
  it('refuses an expense already synced to Zoho', () => {
    const result = planAccountantDetailsEdit(
      { ...base, zohoExpenseId: 'zoho-123' },
      { merchant: 'Summitt Labs' },
      [],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('NOT_EDITABLE');
    expect(result.refusal.status).toBe(409);
  });

  it('refuses when the expense already sits in a closed period', () => {
    const result = planAccountantDetailsEdit(base, { merchant: 'Summitt Labs' }, ['2026-05']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('PERIOD_CLOSED');
    expect(result.refusal.message).toContain('2026-05');
  });

  it('refuses a date edit that moves the expense into a closed period', () => {
    const result = planAccountantDetailsEdit(base, { date: '2026-04-30' }, ['2026-04']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('PERIOD_CLOSED');
    expect(result.refusal.message).toContain('2026-04');
  });

  it('allows a date edit between two open periods', () => {
    const result = planAccountantDetailsEdit(base, { date: '2026-06-01' }, ['2026-04']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ date: '2026-06-01' });
  });

  it('returns only the fields that actually changed', () => {
    const result = planAccountantDetailsEdit(
      base,
      { merchant: 'Summitt Labs', amount: 948, date: '2026-05-05' },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ merchant: 'Summitt Labs' });
  });

  it('treats a numerically equal amount as unchanged despite string storage', () => {
    const result = planAccountantDetailsEdit(base, { amount: 948.0 }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({});
  });

  it('records an amount change as a fixed-2 string for the numeric column', () => {
    const result = planAccountantDetailsEdit(base, { amount: 1020.5 }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ amount: '1020.50' });
  });

  it('trims merchant and ignores a whitespace-only difference', () => {
    const result = planAccountantDetailsEdit(base, { merchant: '  Summitt labs  ' }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({});
  });

  it('sets the payment method when the expense has none', () => {
    const result = planAccountantDetailsEdit(base, { paymentMethodId: 'pm-1' }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ paymentMethodId: 'pm-1' });
  });

  it('is a no-op when the payment method is already set to the same card', () => {
    const result = planAccountantDetailsEdit(
      { ...base, paymentMethodId: 'pm-1' },
      { paymentMethodId: 'pm-1' },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({});
  });

  it('carries several changed fields together', () => {
    const result = planAccountantDetailsEdit(
      base,
      { merchant: 'Summitt Labs', amount: 1000, date: '2026-06-02', paymentMethodId: 'pm-9' },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({
      merchant: 'Summitt Labs',
      amount: '1000.00',
      date: '2026-06-02',
      paymentMethodId: 'pm-9',
    });
  });

  it('ignores fields the caller omitted entirely', () => {
    const result = planAccountantDetailsEdit(base, {}, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({});
  });
});

describe('planAccountantDetailsEdit — notes', () => {
  const withNotes = { ...base, description: 'Setup day -dinner with Haute team' };

  it('writes an edited note', () => {
    const result = planAccountantDetailsEdit(
      withNotes,
      { description: 'Setup day -dinner with Haute team, 8 attendees' },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ description: 'Setup day -dinner with Haute team, 8 attendees' });
  });

  it('adds a note to an expense that had none', () => {
    const result = planAccountantDetailsEdit(base, { description: 'Client dinner' }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ description: 'Client dinner' });
  });

  it('trims the note and ignores a whitespace-only difference', () => {
    const result = planAccountantDetailsEdit(
      withNotes,
      { description: '  Setup day -dinner with Haute team  ' },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({});
  });

  it('clears the note to null on an empty string', () => {
    const result = planAccountantDetailsEdit(withNotes, { description: '' }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ description: null });
  });

  it('clears the note to null on a whitespace-only string', () => {
    const result = planAccountantDetailsEdit(withNotes, { description: '   ' }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ description: null });
  });

  it('writes nothing when clearing an expense that has no note', () => {
    const result = planAccountantDetailsEdit(base, { description: '' }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({});
  });
});

describe('planAccountantDetailsEdit — event re-tag', () => {
  const midasOwned = {
    merchant: 'SPEEDEE MART', amount: '10.46', date: '2026-08-25',
    paymentMethodId: null, description: null, zohoExpenseId: null,
    sourceApp: null, sourceRefId: null, sourceContext: {},
  };

  it('attaches an event to a Midas-owned expense', () => {
    const plan = planAccountantDetailsEdit(
      midasOwned,
      { event: { id: 'evt-1', name: 'Champs Spring LV 2026' } },
      [],
    );
    expect(plan).toEqual({
      ok: true,
      changes: {
        sourceApp: 'trade_show',
        sourceType: 'trade_show_event',
        sourceLabel: 'Champs Spring LV 2026',
        sourceContext: { eventId: 'evt-1', eventName: 'Champs Spring LV 2026' },
      },
    });
  });

  // A tagged row always carries sourceApp alongside the context — the four
  // source columns are written and cleared together.
  const taggedWith = (sourceContext: Record<string, unknown>) => ({
    ...midasOwned, sourceApp: 'trade_show', sourceContext,
  });

  it('clears the event back to daily', () => {
    const plan = planAccountantDetailsEdit(taggedWith({ eventId: 'evt-1' }), { event: null }, []);
    expect(plan).toEqual({
      ok: true,
      changes: { sourceApp: null, sourceType: null, sourceLabel: null, sourceContext: {} },
    });
  });

  it('writes nothing when clearing an expense that has no event', () => {
    const plan = planAccountantDetailsEdit(midasOwned, { event: null }, []);
    expect(plan).toEqual({ ok: true, changes: {} });
  });

  it('does not wipe the source columns of a ref-less browser-extension capture', () => {
    // pageUrl is optional on the extension's submit, so sourceApp can be set
    // with sourceRefId null — which passes the ownership guard above. Clearing
    // "the event" of such a row must leave its provenance alone.
    const capture = { ...midasOwned, sourceApp: 'browser_extension' };
    expect(planAccountantDetailsEdit(capture, { event: null }, [])).toEqual({ ok: true, changes: {} });
  });

  it('is a no-op when the same event is re-selected', () => {
    const tagged = taggedWith({ eventId: 'evt-1', eventName: 'Champs Spring LV 2026' });
    const plan = planAccountantDetailsEdit(
      tagged,
      { event: { id: 'evt-1', name: 'Champs Spring LV 2026' } },
      [],
    );
    expect(plan).toEqual({ ok: true, changes: {} });
  });

  it('refuses to re-tag an Argo-created row, whose (source_app, source_ref_id) is Argo\'s idempotency key', () => {
    const argoOwned = { ...midasOwned, sourceApp: 'trade_show', sourceRefId: 'ts-4471' };
    const plan = planAccountantDetailsEdit(argoOwned, { event: null }, []);
    expect(plan).toMatchObject({ ok: false, refusal: { code: 'EVENT_NOT_EDITABLE', status: 409 } });
    if (plan.ok) return;
    expect(plan.refusal.message).toContain('trade show app');
  });

  it('refuses to re-tag a browser-extension-owned row, with wording that names the extension, not Argo', () => {
    const extensionOwned = {
      ...midasOwned, sourceApp: 'browser_extension', sourceRefId: 'https://example.com/receipt',
    };
    const plan = planAccountantDetailsEdit(extensionOwned, { event: null }, []);
    expect(plan).toMatchObject({ ok: false, refusal: { code: 'EVENT_NOT_EDITABLE', status: 409 } });
    if (plan.ok) return;
    expect(plan.refusal.message).toContain('browser extension');
    expect(plan.refusal.message).not.toContain('trade show app');
  });

  it('still refuses every edit once pushed to Zoho', () => {
    const pushed = { ...midasOwned, zohoExpenseId: 'zoho-1' };
    const plan = planAccountantDetailsEdit(
      pushed,
      { event: { id: 'evt-1', name: 'Champs Spring LV 2026' } },
      [],
    );
    expect(plan).toMatchObject({ ok: false, refusal: { code: 'NOT_EDITABLE', status: 409 } });
  });
});
