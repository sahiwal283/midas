import { describe, expect, it } from 'vitest';
import {
  selectionCutoff,
  orderSelectableEvents,
  eventSourceFields,
  CLEARED_EVENT_SOURCE_FIELDS,
  resolveEventPatch,
  eventOwnershipRefusal,
  eventChangeFor,
  currentEventId,
  hasEventTag,
} from '../lib/eventSelection';

describe('selectionCutoff', () => {
  it('is one month and one day past the end date', () => {
    expect(selectionCutoff('2026-11-03')).toBe('2026-12-04');
  });

  it('mirrors Argo month-overflow rather than clamping to month end', () => {
    // Argo does setMonth(+1) then setDate(+1) on a JS Date, so Jan 31 rolls
    // through Feb 31 -> Mar 3, then +1 day. Reproduced exactly, not "fixed" —
    // the two apps must agree on which events are selectable.
    expect(selectionCutoff('2026-01-31')).toBe('2026-03-04');
  });

  it('handles a leap-year February', () => {
    expect(selectionCutoff('2028-01-31')).toBe('2028-03-03');
  });
});

describe('orderSelectableEvents', () => {
  const events = [
    { id: 'c', name: 'Champs Chicago', city: null, state: null, startDate: '2026-09-10', endDate: '2026-09-12' },
    { id: 'a', name: 'Champs Austin', city: null, state: null, startDate: '2026-01-16', endDate: '2026-01-18' },
    { id: 'v', name: 'Champs Vegas', city: null, state: null, startDate: '2026-08-24', endDate: '2026-08-26' },
    { id: 'o', name: 'Old Show', city: null, state: null, startDate: '2025-03-01', endDate: '2025-03-03' },
  ];

  it('puts selectable events first by soonest start, then past by most recent end', () => {
    const ordered = orderSelectableEvents(events, '2026-08-26');
    expect(ordered.map((e) => e.id)).toEqual(['v', 'c', 'a', 'o']);
  });

  it('flags past events', () => {
    const byId = new Map(orderSelectableEvents(events, '2026-08-26').map((e) => [e.id, e.isPast]));
    expect(byId.get('v')).toBe(false);
    expect(byId.get('c')).toBe(false);
    expect(byId.get('a')).toBe(true);
    expect(byId.get('o')).toBe(true);
  });

  it('treats the cutoff day itself as past', () => {
    const one = [{ id: 'x', name: 'X', city: null, state: null, startDate: '2026-11-01', endDate: '2026-11-03' }];
    expect(orderSelectableEvents(one, '2026-12-03')[0].isPast).toBe(false);
    expect(orderSelectableEvents(one, '2026-12-04')[0].isPast).toBe(true);
  });
});

describe('eventSourceFields', () => {
  it('writes the trade_show contract, taking the label from the event row', () => {
    expect(eventSourceFields({ id: 'evt-1', name: 'Champs Spring LV 2026' })).toEqual({
      sourceApp: 'trade_show',
      sourceType: 'trade_show_event',
      sourceLabel: 'Champs Spring LV 2026',
      sourceContext: { eventId: 'evt-1', eventName: 'Champs Spring LV 2026' },
    });
  });

  it('clears back to a daily expense', () => {
    expect(CLEARED_EVENT_SOURCE_FIELDS).toEqual({
      sourceApp: null,
      sourceType: null,
      sourceLabel: null,
      sourceContext: {},
    });
  });
});

describe('hasEventTag / currentEventId', () => {
  const tagged = { sourceApp: 'trade_show', sourceContext: { eventId: 'evt-1', eventName: 'Champs' } };

  it('reads the event off a tagged row', () => {
    expect(hasEventTag(tagged)).toBe(true);
    expect(currentEventId(tagged)).toBe('evt-1');
  });

  it('sees no event on an untagged row', () => {
    expect(hasEventTag({ sourceApp: null, sourceContext: {} })).toBe(false);
    expect(currentEventId({ sourceApp: null, sourceContext: {} })).toBeNull();
  });

  it('sees no event on a row another app created', () => {
    // A browser-extension capture with no page URL: sourceApp set, no event.
    const capture = { sourceApp: 'browser_extension', sourceContext: {} };
    expect(hasEventTag(capture)).toBe(false);
    expect(currentEventId(capture)).toBeNull();
  });

  it('still reports a tag when the context lost its eventId', () => {
    expect(hasEventTag({ sourceApp: 'trade_show', sourceContext: {} })).toBe(true);
    expect(currentEventId({ sourceApp: 'trade_show', sourceContext: {} })).toBeNull();
  });
});

describe('eventChangeFor', () => {
  const event = { id: 'evt-1', name: 'Champs Spring LV 2026' };
  const daily = { sourceApp: null, sourceContext: {} };
  const tagged = { sourceApp: 'trade_show', sourceContext: { eventId: 'evt-1', eventName: 'Champs Spring LV 2026' } };

  it('writes the source fields when attaching an event', () => {
    expect(eventChangeFor(daily, event)).toEqual(eventSourceFields(event));
  });

  it('writes nothing when the row already has that event', () => {
    expect(eventChangeFor(tagged, event)).toBeUndefined();
  });

  it('writes the new event when re-tagging', () => {
    const next = { id: 'evt-2', name: 'Champs Chicago 2026' };
    expect(eventChangeFor(tagged, next)).toEqual(eventSourceFields(next));
  });

  it('clears a row that actually has an event', () => {
    expect(eventChangeFor(tagged, null)).toEqual(CLEARED_EVENT_SOURCE_FIELDS);
  });

  it('writes nothing when clearing a row that has no event', () => {
    expect(eventChangeFor(daily, null)).toBeUndefined();
  });

  it('does not wipe browser-extension provenance on a clear', () => {
    // pageUrl is optional on the extension's submit, so a capture can have
    // sourceApp set with sourceRefId null — which passes the ownership guard.
    // Clearing "the event" of such a row must not null its source columns.
    const capture = { sourceApp: 'browser_extension', sourceContext: {} };
    expect(eventChangeFor(capture, null)).toBeUndefined();
  });
});

describe('resolveEventPatch', () => {
  const lookup = async (id: string) =>
    id === 'evt-1' ? { id: 'evt-1', name: 'Champs Spring LV 2026' } : null;
  const tagged = { sourceApp: 'trade_show', sourceContext: { eventId: 'evt-9', eventName: 'Old Show' } };

  it('leaves the expense alone when eventId is absent', async () => {
    expect(await resolveEventPatch(undefined, lookup, tagged)).toBeUndefined();
  });

  it('clears the event when eventId is null and the row has one', async () => {
    expect(await resolveEventPatch(null, lookup, tagged)).toEqual(CLEARED_EVENT_SOURCE_FIELDS);
  });

  it('writes nothing when eventId is null and the row has no event', async () => {
    const capture = { sourceApp: 'browser_extension', sourceContext: {} };
    expect(await resolveEventPatch(null, lookup, capture)).toBeUndefined();
    expect(await resolveEventPatch(null, lookup, { sourceApp: null, sourceContext: {} })).toBeUndefined();
  });

  it('writes nothing when eventId is null on a create (no row yet)', async () => {
    expect(await resolveEventPatch(null, lookup, null)).toBeUndefined();
  });

  it('resolves a known event to its source fields', async () => {
    expect(await resolveEventPatch('evt-1', lookup, null)).toEqual({
      sourceApp: 'trade_show',
      sourceType: 'trade_show_event',
      sourceLabel: 'Champs Spring LV 2026',
      sourceContext: { eventId: 'evt-1', eventName: 'Champs Spring LV 2026' },
    });
  });

  it('throws UNKNOWN_EVENT rather than silently leaving the expense untagged', async () => {
    await expect(resolveEventPatch('nope', lookup, null)).rejects.toMatchObject({
      code: 'UNKNOWN_EVENT',
      statusCode: 400,
    });
  });

  it('throws UNKNOWN_EVENT for an id the adapter cannot parse', async () => {
    // findSelectableEvent maps Postgres 22P02 to null, so a non-uuid id is an
    // unknown event (400), not an uncaught database error (500).
    await expect(resolveEventPatch('not-a-uuid', async () => null, null)).rejects.toMatchObject({
      code: 'UNKNOWN_EVENT',
      statusCode: 400,
    });
  });
});

describe('eventOwnershipRefusal', () => {
  it('allows the edit on a Midas-owned row (null sourceRefId)', () => {
    expect(eventOwnershipRefusal('trade_show', null)).toBeNull();
    expect(eventOwnershipRefusal(null, null)).toBeNull();
  });

  it('refuses a trade_show-owned row with trade-show wording', () => {
    const refusal = eventOwnershipRefusal('trade_show', 'ts-4471');
    expect(refusal).toMatchObject({ code: 'EVENT_NOT_EDITABLE', status: 409 });
    expect(refusal?.message).toContain('trade show app');
  });

  it('refuses a browser_extension-owned row with extension wording, not trade-show wording', () => {
    const refusal = eventOwnershipRefusal('browser_extension', 'https://example.com/receipt');
    expect(refusal).toMatchObject({ code: 'EVENT_NOT_EDITABLE', status: 409 });
    expect(refusal?.message).toContain('browser extension');
    expect(refusal?.message).not.toContain('trade show app');
  });

  it('still refuses an unrecognized sourceApp, with a generic message naming it', () => {
    const refusal = eventOwnershipRefusal('milo', 'payroll-99');
    expect(refusal).toMatchObject({ code: 'EVENT_NOT_EDITABLE', status: 409 });
    expect(refusal?.message).toContain('milo');
  });

  it('still refuses a null sourceApp paired with a non-null sourceRefId', () => {
    // Shouldn't happen given the app's own write paths, but sourceRefId is
    // the ownership signal — a row with a ref and no recorded app name is
    // still not Midas's to edit.
    const refusal = eventOwnershipRefusal(null, 'orphan-ref');
    expect(refusal).toMatchObject({ code: 'EVENT_NOT_EDITABLE', status: 409 });
  });
});
