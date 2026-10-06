import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Scroll to the element named by the URL hash once the page has something to
 * scroll to. React Router does not do this itself, and a notification link
 * like `/expenses/<id>#conversation` arrives before the expense has loaded —
 * `ready` is the caller saying the target is now in the DOM.
 */
export function useScrollToHash(ready: boolean): void {
  const { hash, key } = useLocation();

  useEffect(() => {
    if (!ready || !hash) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(hash.slice(1))?.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'start',
    });
    // `key` changes on every navigation, so tapping a second notification for
    // the page already open scrolls again.
  }, [ready, hash, key]);
}
