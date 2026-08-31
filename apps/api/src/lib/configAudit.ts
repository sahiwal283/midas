/**
 * Startup audit for production configuration.
 *
 * Several Midas features sit behind an adapter that no-ops when its env var is
 * unset — web push, the payroll drawer, the trade-show calendar. That
 * is deliberate (a laptop should not need them), but it means a production box
 * missing those keys degrades *silently*: no error, no failed request, the
 * feature simply stops existing.
 *
 * On 2026-08-24 a laptop `.env` was deployed over production and the recovery
 * restored a two-week-old backup. Web push, the payroll drawer, the trade-show
 * calendar and two Authentik group mappings were reverted at once, and nothing
 * reported it — the SSO lockout only surfaced days later when a container
 * restart finally reloaded the file. This audit turns that class of silent
 * rollback into a loud one.
 */

export interface ConfigRequirement {
  /** Env var(s) that must all be non-empty for the feature to work. */
  keys: string[];
  /** What stops working when they are missing. */
  feature: string;
}

export interface MissingConfig {
  keys: string[];
  feature: string;
}

export interface ConfigAuditResult {
  ok: boolean;
  missing: MissingConfig[];
}

/** Features that a production deployment is expected to have configured. */
export const PRODUCTION_REQUIREMENTS: ConfigRequirement[] = [
  { keys: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'], feature: 'Web push notifications' },
  { keys: ['PAYROLL_DATABASE_URL'], feature: 'Cashbook payroll drawer' },
  { keys: ['TRADESHOW_DATABASE_URL'], feature: 'Trade show event calendar' },
  { keys: ['ZOHO_SERVICE_TOKEN', 'ZOHO_SERVICE_BASE_URL'], feature: 'Zoho Books sync' },
];

/**
 * Authentik group lists that still equal these defaults mean the deployment
 * never mapped its real group names — every SSO login is denied with
 * "not assigned to a Midas access group".
 */
export const AUTHENTIK_GROUP_DEFAULTS: Record<string, string[]> = {
  AUTHENTIK_GROUP_ADMIN: ['app-midas-admins', 'midas-admins'],
  AUTHENTIK_GROUP_ACCOUNTANT: ['app-midas-accountants', 'midas-accountants'],
  AUTHENTIK_GROUP_USER: ['app-midas-users', 'midas-users'],
};

function isSet(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

/**
 * Reports production config that is absent. Only meaningful in production —
 * a dev box is expected to run without these, so `production: false` is always ok.
 */
export function auditProductionConfig(
  source: Record<string, unknown>,
  opts: { production: boolean; requirements?: ConfigRequirement[] },
): ConfigAuditResult {
  if (!opts.production) return { ok: true, missing: [] };

  const requirements = opts.requirements ?? PRODUCTION_REQUIREMENTS;
  const missing = requirements
    .map((req) => ({ ...req, keys: req.keys.filter((k) => !isSet(source, k)) }))
    .filter((req) => req.keys.length > 0)
    .map(({ keys, feature }) => ({ keys, feature }));

  return { ok: missing.length === 0, missing };
}

/**
 * True when a group list is still the built-in default — i.e. it was never
 * pointed at the identity provider's real group names.
 */
export function authentikGroupsLookUnconfigured(
  groups: Record<string, string[] | undefined>,
): string[] {
  return Object.entries(AUTHENTIK_GROUP_DEFAULTS)
    .filter(([key, defaults]) => {
      const actual = groups[key];
      if (!actual || actual.length === 0) return true;
      return actual.length === defaults.length && actual.every((g, i) => g === defaults[i]);
    })
    .map(([key]) => key);
}
