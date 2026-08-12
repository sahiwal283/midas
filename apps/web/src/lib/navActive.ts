/**
 * Active-state for the Accountant sidebar links.
 *
 * The review queue is now two pages under /accountant. An expense detail page
 * (/accountant/<id>) belongs to whichever queue the user came from, but the URL
 * alone cannot say which — so neither page is marked active there rather than
 * guessing wrong.
 */
export interface NavLocation {
  pathname: string;
  search: string;
}

export function accountantNavActive(location: NavLocation): {
  eventReview: boolean;
  dailyReview: boolean;
} {
  const { pathname } = location;
  return {
    eventReview: pathname === '/accountant/events',
    dailyReview: pathname === '/accountant/daily',
  };
}
