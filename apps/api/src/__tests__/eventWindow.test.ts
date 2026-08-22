import { describe, expect, it } from 'vitest';
import {
  classifyEventWindow,
  compareEventWindow,
  daysBetween,
  isInEventWindow,
} from '../lib/eventWindow';

const TODAY = '2026-08-22';

/** Champs Summer LV 2026 as it exists in the trade show app. */
const champs = {
  startDate: '2026-08-26',
  endDate: '2026-08-29',
  travelStartDate: '2026-08-25',
  travelEndDate: '2026-08-29',
};

describe('daysBetween', () => {
  it('counts whole days forward and backward', () => {
    expect(daysBetween('2026-08-22', '2026-08-25')).toBe(3);
    expect(daysBetween('2026-08-25', '2026-08-22')).toBe(-3);
    expect(daysBetween('2026-08-22', '2026-08-22')).toBe(0);
  });

  it('is not thrown off by a DST boundary', () => {
    // US DST ends 2026-11-01; a naive local-time diff would return 30.958…
    expect(daysBetween('2026-10-25', '2026-11-05')).toBe(11);
  });
});

describe('classifyEventWindow', () => {
  it('counts down to the travel date, not the show date', () => {
    const s = classifyEventWindow(champs, TODAY);
    expect(s.phase).toBe('upcoming');
    expect(s.days).toBe(3); // travel starts 8/25, show floor opens 8/26
    expect(s.effectiveStart).toBe('2026-08-25');
  });

  it('is active from the first travel day through the last show day', () => {
    expect(classifyEventWindow(champs, '2026-08-25').phase).toBe('active');
    expect(classifyEventWindow(champs, '2026-08-27').phase).toBe('active');
    expect(classifyEventWindow(champs, '2026-08-29').phase).toBe('active');
  });

  it('reports days since the end once it is over', () => {
    const s = classifyEventWindow(champs, '2026-09-03');
    expect(s.phase).toBe('recent');
    expect(s.days).toBe(5);
  });

  it('falls back to show dates when travel dates are missing', () => {
    const noTravel = { startDate: '2026-08-26', endDate: '2026-08-29', travelStartDate: null, travelEndDate: null };
    const s = classifyEventWindow(noTravel, TODAY);
    expect(s.effectiveStart).toBe('2026-08-26');
    expect(s.days).toBe(4);
  });
});

describe('isInEventWindow', () => {
  it('includes events at exactly the 10-day edges', () => {
    const start = { startDate: '2026-09-01', endDate: '2026-09-03', travelStartDate: '2026-09-01', travelEndDate: '2026-09-03' };
    expect(isInEventWindow(start, '2026-08-22')).toBe(true); // starts in exactly 10
    const ended = { startDate: '2026-08-10', endDate: '2026-08-12', travelStartDate: '2026-08-10', travelEndDate: '2026-08-12' };
    expect(isInEventWindow(ended, '2026-08-22')).toBe(true); // ended exactly 10 ago
  });

  it('excludes events just outside the window', () => {
    const far = { startDate: '2026-09-02', endDate: '2026-09-04', travelStartDate: '2026-09-02', travelEndDate: '2026-09-04' };
    expect(isInEventWindow(far, '2026-08-22')).toBe(false);
    const old = { startDate: '2026-08-08', endDate: '2026-08-11', travelStartDate: '2026-08-08', travelEndDate: '2026-08-11' };
    expect(isInEventWindow(old, '2026-08-22')).toBe(false);
  });

  it('always includes a long-running event in progress', () => {
    const long = { startDate: '2026-07-01', endDate: '2026-09-30', travelStartDate: null, travelEndDate: null };
    expect(isInEventWindow(long, '2026-08-22')).toBe(true);
  });
});

describe('compareEventWindow', () => {
  it('orders active first, then soonest upcoming, then most recently ended', () => {
    const states = [
      classifyEventWindow({ startDate: '2026-08-30', endDate: '2026-08-31' }, TODAY),   // upcoming 8
      classifyEventWindow({ startDate: '2026-08-14', endDate: '2026-08-16' }, TODAY),   // recent 6
      classifyEventWindow({ startDate: '2026-08-20', endDate: '2026-08-24' }, TODAY),   // active
      classifyEventWindow({ startDate: '2026-08-25', endDate: '2026-08-27' }, TODAY),   // upcoming 3
    ];
    const order = [...states].sort(compareEventWindow).map((s) => `${s.phase}:${s.days}`);
    expect(order).toEqual(['active:0', 'upcoming:3', 'upcoming:8', 'recent:6']);
  });
});
