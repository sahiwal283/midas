import { describe, it, expect } from 'vitest';
import { planAccountantDetailsEdit, type DetailsEditTarget } from '../lib/accountantDetailsEdit';

const base: DetailsEditTarget = {
  zohoEntity: null,
  merchant: 'Summitt labs',
  amount: '948.00',
  date: '2026-05-05',
  paymentMethodId: null,
  categoryId: null,
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
    zohoEntity: null, merchant: 'SPEEDEE MART', amount: '10.46', date: '2026-08-25',
    paymentMethodId: null, categoryId: null, description: null, zohoExpenseId: null,
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

describe('planAccountantDetailsEdit — company', () => {
  // The reason this field exists: an approved expense with no company cannot be
  // pushed, and until now no accountant control could set one.
  it('sets the company on an expense that has none', () => {
    const result = planAccountantDetailsEdit(base, { zohoEntity: 'Boomin Brands' }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ zohoEntity: 'Boomin Brands' });
  });

  it('corrects a company that was set to the wrong one', () => {
    const result = planAccountantDetailsEdit(
      { ...base, zohoEntity: 'Haute Brands' },
      { zohoEntity: 'Nirvana Kulture' },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ zohoEntity: 'Nirvana Kulture' });
  });

  it('writes nothing when the company is unchanged', () => {
    const result = planAccountantDetailsEdit(
      { ...base, zohoEntity: 'Haute Brands' },
      { zohoEntity: 'Haute Brands' },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({});
  });

  // Zoho holds the record once pushed; the company decides which org it was
  // filed in, so a Midas-side rewrite would put the two permanently out of step.
  it('refuses a company change on an expense already pushed to Zoho', () => {
    const result = planAccountantDetailsEdit(
      { ...base, zohoExpenseId: 'zoho-123' },
      { zohoEntity: 'Boomin Brands' },
      [],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('NOT_EDITABLE');
  });

  it('refuses a company change in a closed period', () => {
    const result = planAccountantDetailsEdit(base, { zohoEntity: 'Boomin Brands' }, ['2026-05']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('PERIOD_CLOSED');
  });
});

describe('planAccountantDetailsEdit — notes after Zoho push', () => {
  // The accountant's request: the note is Midas-side context, not a Zoho
  // field, so it stays correctable after the push. Everything else keeps the
  // refusal — the amount, date, card and company are Zoho's record now.
  const pushed = { ...base, zohoExpenseId: 'zoho-123', description: 'mop sink' };

  it('allows a notes-only edit on a pushed expense once the Midas-only change is confirmed', () => {
    const result = planAccountantDetailsEdit(
      pushed,
      { description: 'mop sink for the warehouse', confirmSynced: true },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ description: 'mop sink for the warehouse' });
  });

  it('asks for confirmation before a notes-only edit on a pushed expense', () => {
    const result = planAccountantDetailsEdit(pushed, { description: 'mop sink for the warehouse' }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('CONFIRM_SYNCED');
    expect(result.refusal.status).toBe(409);
    expect(result.refusal.message).toContain('Zoho');
  });

  it('does not ask for confirmation when the pushed note is unchanged', () => {
    const result = planAccountantDetailsEdit(pushed, { description: '  mop sink ' }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({});
  });

  it('still refuses a pushed edit that touches notes together with any other field', () => {
    const result = planAccountantDetailsEdit(
      pushed,
      { description: 'mop sink for the warehouse', amount: 170, confirmSynced: true },
      [],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('NOT_EDITABLE');
  });

  it('ignores the confirmation flag on an expense that was never pushed', () => {
    const result = planAccountantDetailsEdit(
      base,
      { description: 'first note', merchant: 'Summitt Labs', confirmSynced: true },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ description: 'first note', merchant: 'Summitt Labs' });
  });
});

describe('planAccountantDetailsEdit — category', () => {
  const travel = '11111111-1111-4111-8111-111111111111';
  const booth = '22222222-2222-4222-8222-222222222222';

  it('sets the category alongside other corrections before the push', () => {
    const result = planAccountantDetailsEdit(
      { ...base, categoryId: travel },
      { categoryId: booth, merchant: 'Summitt Labs' },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ categoryId: booth, merchant: 'Summitt Labs' });
  });

  it('writes nothing when the category is unchanged', () => {
    const result = planAccountantDetailsEdit({ ...base, categoryId: travel }, { categoryId: travel }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({});
  });
});

describe('planAccountantDetailsEdit — labels after Zoho push', () => {
  // Notes and category are what the reports group and read by. Neither is
  // written back to Zoho, so both stay correctable once the expense is there.
  const travel = '11111111-1111-4111-8111-111111111111';
  const booth = '22222222-2222-4222-8222-222222222222';
  const pushed = { ...base, zohoExpenseId: 'zoho-123', description: 'mop sink', categoryId: travel };

  it('allows a category-only edit on a pushed expense once confirmed', () => {
    const result = planAccountantDetailsEdit(pushed, { categoryId: booth, confirmSynced: true }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ categoryId: booth });
  });

  it('asks for confirmation before a category-only edit on a pushed expense', () => {
    const result = planAccountantDetailsEdit(pushed, { categoryId: booth }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('CONFIRM_SYNCED');
    expect(result.refusal.message).toContain('the category');
  });

  it('carries notes and category together under one confirmation', () => {
    const result = planAccountantDetailsEdit(
      pushed,
      { description: 'booth deposit', categoryId: booth, confirmSynced: true },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ description: 'booth deposit', categoryId: booth });
  });

  it('names both fields when asking to confirm a notes and category edit', () => {
    const result = planAccountantDetailsEdit(pushed, { description: 'booth deposit', categoryId: booth }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('CONFIRM_SYNCED');
    expect(result.refusal.message).toContain('the notes and category');
  });

  it('does not ask for confirmation when neither label actually changes', () => {
    const result = planAccountantDetailsEdit(pushed, { description: 'mop sink', categoryId: travel }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({});
  });

  it('still refuses a pushed edit that touches the category together with a financial field', () => {
    const result = planAccountantDetailsEdit(
      pushed,
      { categoryId: booth, date: '2026-05-06', confirmSynced: true },
      [],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('NOT_EDITABLE');
  });
});

describe('planAccountantDetailsEdit — labels in a closed period', () => {
  // Closing a month freezes its money: amounts, dates, cards, companies.
  // Notes and category only change how a report reads, so they stay open.
  const booth = '22222222-2222-4222-8222-222222222222';

  it('allows a notes edit in a closed period', () => {
    const result = planAccountantDetailsEdit(base, { description: 'booth deposit' }, ['2026-05']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ description: 'booth deposit' });
  });

  it('allows a category edit in a closed period', () => {
    const result = planAccountantDetailsEdit(base, { categoryId: booth }, ['2026-05']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ categoryId: booth });
  });

  it('allows a confirmed label edit on a pushed expense in a closed period', () => {
    const result = planAccountantDetailsEdit(
      { ...base, zohoExpenseId: 'zoho-123' },
      { description: 'booth deposit', categoryId: booth, confirmSynced: true },
      ['2026-05'],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual({ description: 'booth deposit', categoryId: booth });
  });

  it('still refuses a label edit that rides with a financial field in a closed period', () => {
    const result = planAccountantDetailsEdit(base, { description: 'booth deposit', amount: 950 }, ['2026-05']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('PERIOD_CLOSED');
  });
});
