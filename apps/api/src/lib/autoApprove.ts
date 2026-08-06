/** Daily-expense auto-push: complete staff-entered expenses skip accountant approval. */

const AUTO_PUSH_SOURCES = new Set<string | null>([null, 'browser_extension']);

/** Event/external expenses (trade_show, …) always require accountant approval. */
export function isAutoPushEligible(i: { sourceApp: string | null; ready: boolean }): boolean {
  return AUTO_PUSH_SOURCES.has(i.sourceApp) && i.ready;
}
