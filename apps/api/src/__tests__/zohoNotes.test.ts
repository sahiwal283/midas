import { describe, expect, it } from 'vitest';
import { buildZohoNote, ZOHO_NOTE_MAX } from '../lib/zohoNotes';

const BASE = {
  headline: 'SPEEDEE MART 109 — Beverage for set up day',
  event: 'Champs Summer LV 2026',
  submittedBy: 'Shruti Patel',
  submittedOn: '2026-08-25',
  pushedBy: 'Sahil Khatri',
  pushedOn: '2026-08-27',
  origin: 'browser_extension',
  midasUrl: 'https://midas.example/expenses/3658f567',
  midasId: '3658f567',
};

describe('buildZohoNote', () => {
  it('puts the human line first, then a labelled provenance block', () => {
    expect(buildZohoNote(BASE)).toBe(
      'SPEEDEE MART 109 — Beverage for set up day\n'
      + '\n'
      + 'Event: Champs Summer LV 2026\n'
      + 'Submitted by: Shruti Patel on 2026-08-25\n'
      + 'Pushed by: Sahil Khatri on 2026-08-27\n'
      + 'Origin: Midas Extension\n'
      + 'Midas: https://midas.example/expenses/3658f567',
    );
  });

  it('spells out the event dates so Zoho shows when it ran', () => {
    const ev = (start: string | null, end: string | null) =>
      buildZohoNote({ ...BASE, eventStart: start, eventEnd: end })
        .split('\n').find((l) => l.startsWith('Event:'));
    // A range inside one month names the month once.
    expect(ev('2026-08-24', '2026-08-27')).toBe('Event: Champs Summer LV 2026 (Aug 24–27, 2026)');
    // Crossing a month boundary needs both months, but still one year.
    expect(ev('2026-01-28', '2026-02-02')).toBe('Event: Champs Summer LV 2026 (Jan 28 – Feb 2, 2026)');
    // Crossing a year needs both years spelled out.
    expect(ev('2025-12-28', '2026-01-02')).toBe('Event: Champs Summer LV 2026 (Dec 28, 2025 – Jan 2, 2026)');
    // A one-day event reads as a single date, not a range against itself.
    expect(ev('2026-09-14', '2026-09-14')).toBe('Event: Champs Summer LV 2026 (Sep 14, 2026)');
  });

  it('leaves the event name bare when Argo could not supply dates', () => {
    // The trade-show link is best-effort; a push must never wait on it.
    expect(buildZohoNote({ ...BASE, eventStart: null, eventEnd: null }))
      .toContain('Event: Champs Summer LV 2026\n');
    expect(buildZohoNote({ ...BASE, eventStart: '2026-08-24', eventEnd: null }))
      .toContain('Event: Champs Summer LV 2026\n');
  });

  it('never dates an event it does not have', () => {
    expect(buildZohoNote({ ...BASE, event: null, eventStart: '2026-08-24', eventEnd: '2026-08-27' }))
      .toContain('Event: —');
  });

  it('keeps the core lines at a fixed shape, marking absent values', () => {
    const note = buildZohoNote({ ...BASE, event: null });
    expect(note).toContain('Event: —');
  });

  it('names each origin the way an accountant would recognise it', () => {
    const origin = (o: string | null) =>
      buildZohoNote({ ...BASE, origin: o }).split('\n').find((l) => l.startsWith('Origin:'));
    expect(origin(null)).toBe('Origin: Midas');
    expect(origin('midas')).toBe('Origin: Midas');
    expect(origin('browser_extension')).toBe('Origin: Midas Extension');
    expect(origin('trade_show')).toBe('Origin: Argo (Trade Show)');
  });

  it('passes an unrecognised origin through rather than hiding it', () => {
    expect(buildZohoNote({ ...BASE, origin: 'some_new_app' })).toContain('Origin: some_new_app');
  });

  it('falls back to the bare id when no web base url is configured', () => {
    expect(buildZohoNote({ ...BASE, midasUrl: null })).toContain('Midas: 3658f567');
  });

  it('includes the capture page only when there is one', () => {
    expect(buildZohoNote(BASE)).not.toContain('Source:');
    expect(buildZohoNote({ ...BASE, sourceUrl: 'https://shop.example/receipt/9' }))
      .toContain('Source: https://shop.example/receipt/9');
  });

  it('still emits the block when the expense has no description', () => {
    const note = buildZohoNote({ ...BASE, headline: null });
    expect(note.startsWith('Event:')).toBe(true);
    expect(note).toContain('Submitted by: Shruti Patel on 2026-08-25');
  });

  it('truncates the human line, never the provenance', () => {
    const note = buildZohoNote({ ...BASE, headline: 'x'.repeat(ZOHO_NOTE_MAX) });
    expect(note.length).toBeLessThanOrEqual(ZOHO_NOTE_MAX);
    // Everything that exists only in Zoho survives; the prose is in Midas anyway.
    expect(note).toContain('Event: Champs Summer LV 2026');
    expect(note).toContain('Midas: https://midas.example/expenses/3658f567');
    expect(note).toContain('…');
  });

  it('drops the human line entirely when the block alone fills the budget', () => {
    const note = buildZohoNote({
      ...BASE,
      headline: 'x'.repeat(ZOHO_NOTE_MAX),
      event: 'e'.repeat(ZOHO_NOTE_MAX),
    });
    expect(note.length).toBeLessThanOrEqual(ZOHO_NOTE_MAX);
    expect(note.startsWith('Event:')).toBe(true);
  });
});
