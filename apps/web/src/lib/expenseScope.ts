/**
 * Trade-show vs daily classification for an expense. Mirrors the server rule
 * in apps/api/src/lib/queueScope.ts (isDailyExpense): daily = entered in Midas
 * directly or captured with the browser extension; trade show = pushed from an
 * external app (trade_show, argo, …). Exact complements — every expense is
 * exactly one of the two.
 */
export function isDailyExpense(e: { sourceApp: string | null }): boolean {
  return e.sourceApp === null || e.sourceApp === 'browser_extension';
}

export function isTradeShowExpense(e: { sourceApp: string | null }): boolean {
  return !isDailyExpense(e);
}
