/**
 * Which sourceApp an Ext connection speaks for.
 *
 * `app_name` identifies the CREDENTIAL and often carries an environment suffix
 * ("trade_show_prod", plus a separate "trade_show" key for the sandbox).
 * `source_app` identifies the DATA those credentials own, and several
 * connections legitimately share one — every Trade Show expense is written with
 * sourceApp "trade_show" regardless of which key created it.
 *
 * Comparing an expense's source_app to app_name therefore 404s every request
 * from a suffixed key. A null source_app falls back to app_name, which keeps
 * behaviour unchanged for connections where the two genuinely match.
 */

export interface ConnectionScopeInput {
  appName: string;
  sourceApp?: string | null;
}

export function connectionSourceApp(conn?: ConnectionScopeInput | null): string {
  return conn?.sourceApp ?? conn?.appName ?? '';
}
