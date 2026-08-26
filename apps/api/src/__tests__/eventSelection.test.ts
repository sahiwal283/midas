import { describe, expect, it } from 'vitest';
import { selectionCutoff, orderSelectableEvents, eventSourceFields, CLEARED_EVENT_SOURCE_FIELDS } from '../lib/eventSelection';

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
