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

describe('buildZohoNote — receipt waiver', () => {
  const BASE = {
    headline: 'Urth Cafe — Breakfast last day KG/SP/SJ',
    event: null,
    submittedBy: 'Shruti Patel',
    submittedOn: '2026-09-09',
    pushedBy: 'Digi',
    pushedOn: '2026-09-10',
    origin: 'midas',
    midasUrl: 'https://midas.example.com/expenses/abc',
    midasId: 'abc',
  };

  it('says nothing about a waiver when there is none', () => {
    expect(buildZohoNote(BASE)).not.toMatch(/waived/i);
  });

  it('names the waiver actor and the reason, after the Pushed by line', () => {
    const note = buildZohoNote({
      ...BASE,
      receiptWaivedBy: 'Digi',
      receiptWaiverReason: 'submitter lost the receipt; verified against the Amex statement',
    });
    expect(note).toContain('Receipt waived by Digi: submitter lost the receipt; verified against the Amex statement');
    expect(note.indexOf('Receipt waived by')).toBeGreaterThan(note.indexOf('Pushed by:'));
    expect(note.indexOf('Receipt waived by')).toBeLessThan(note.indexOf('Origin:'));
  });

  it('falls back to an unnamed waiver rather than printing null', () => {
    const note = buildZohoNote({ ...BASE, receiptWaivedBy: null, receiptWaiverReason: 'lost' });
    expect(note).toContain('Receipt waived: lost');
    expect(note).not.toMatch(/null/);
  });

  it('omits the line when a reason is blank', () => {
    expect(buildZohoNote({ ...BASE, receiptWaivedBy: 'Digi', receiptWaiverReason: '   ' }))
      .not.toMatch(/waived/i);
  });

  it('keeps the merchant headline when a 200-character reason is present', () => {
    const note = buildZohoNote({
      ...BASE,
      receiptWaivedBy: 'Digi',
      receiptWaiverReason: 'x'.repeat(200),
    });
    expect(note).toContain('Urth Cafe');
    expect(note.length).toBeLessThanOrEqual(ZOHO_NOTE_MAX);
  });

  it('truncates the waiver line rather than losing the merchant name', () => {
    const note = buildZohoNote({
      ...BASE,
      event: 'A Very Long Trade Show Name That Eats The Budget'.repeat(3),
      receiptWaivedBy: 'Digi',
      receiptWaiverReason: 'y'.repeat(200),
    });
    expect(note.length).toBeLessThanOrEqual(ZOHO_NOTE_MAX);
    expect(note).toContain('Urth Cafe');
    expect(note).toContain('…');
  });

  it('never exceeds the Zoho ceiling under any combination', () => {
    const note = buildZohoNote({
      ...BASE,
      headline: 'H'.repeat(400),
      event: 'E'.repeat(200),
      midasUrl: `https://midas.example.com/expenses/${'u'.repeat(120)}`,
      sourceUrl: `https://example.com/${'s'.repeat(120)}`,
      receiptWaivedBy: 'Digi',
      receiptWaiverReason: 'z'.repeat(200),
    });
    expect(note.length).toBeLessThanOrEqual(ZOHO_NOTE_MAX);
  });

  it('keeps the waiver line even with no headline and a huge event name', () => {
    const note = buildZohoNote({
      ...BASE,
      headline: null,
      event: 'E'.repeat(450),
      receiptWaivedBy: 'Digi',
      receiptWaiverReason: 'lost the receipt at the airport',
    });
    expect(note.length).toBeLessThanOrEqual(ZOHO_NOTE_MAX);
    expect(note).toMatch(/waived/i);
  });

  it('keeps the waiver line with a huge event name and a headline present, honouring the headline floor', () => {
    const note = buildZohoNote({
      ...BASE,
      event: 'E'.repeat(450),
      receiptWaivedBy: 'Digi',
      receiptWaiverReason: 'lost the receipt at the airport',
    });
    expect(note.length).toBeLessThanOrEqual(ZOHO_NOTE_MAX);
    expect(note).toMatch(/waived/i);
    expect(note).toContain('Urth Cafe');
  });

  it('truncates the event line before the waiver line when both are over budget', () => {
    const note = buildZohoNote({
      ...BASE,
      headline: null,
      event: 'E'.repeat(450),
      receiptWaivedBy: 'Digi',
      receiptWaiverReason: 'lost the receipt at the airport',
    });
    const eventLine = note.split('\n').find((l) => l.startsWith('Event:'));
    const waiverLine = note.split('\n').find((l) => l.startsWith('Receipt waived'));
    expect(eventLine).toContain('…');
    expect(waiverLine).toBe('Receipt waived by Digi: lost the receipt at the airport');
  });
});
