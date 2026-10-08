import { describe, it, expect } from 'vitest';
import { shownUnreadCount } from './notificationCount';

describe('shownUnreadCount', () => {
  it('counts a plain row as one', () => {
    expect(shownUnreadCount([{}, {}])).toBe(2);
  });

  it('counts a grouped row as the expenses it stands for', () => {
    expect(shownUnreadCount([{ count: 6 }])).toBe(6);
    expect(shownUnreadCount([{ count: 6 }, {}, { count: 2 }])).toBe(9);
  });

  it('is zero for an empty list', () => {
    expect(shownUnreadCount([])).toBe(0);
  });
});
