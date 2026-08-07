/** Daily-expense auto-push: complete staff-entered expenses skip accountant approval. */

const AUTO_PUSH_SOURCES = new Set<string | null>([null, 'browser_extension']);

/** Event/external expenses (trade_show, …) always require accountant approval. */
export function isAutoPushEligible(i: {
  sourceApp: string | null;
  ready: boolean;
  /** false = the expense's company opted out of Zoho → always accountant queue. */
  companyZohoEnabled?: boolean;
}): boolean {
  if (i.companyZohoEnabled === false) return false;
  return AUTO_PUSH_SOURCES.has(i.sourceApp) && i.ready;
}
