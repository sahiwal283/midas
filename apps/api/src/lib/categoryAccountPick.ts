/**
 * Pure account-selection logic for (category, company) → Zoho COA account.
 *
 * Deliberately imports nothing (no db, no env) so it stays unit-testable —
 * same reason lib/zohoErrors is kept standalone.
 */

/**
 * Zoho Books account ids are org-scoped: every account in one Books org shares
 * a leading run of digits (Haute 5254962…, Nirvana 2212769…, Boomin 4849689…).
 * Midas stores no Zoho org id, so this prefix is the only signal available for
 * telling "this account belongs to that company" apart.
 */
const ORG_PREFIX_LEN = 7;

function orgPrefix(accountId: string): string | null {
  const trimmed = accountId.trim();
  return trimmed.length >= ORG_PREFIX_LEN ? trimmed.slice(0, ORG_PREFIX_LEN) : null;
}

/**
 * The company's Zoho org, inferred from accounts already mapped to it.
 * Returns null when the company has no mappings, or when its mappings
 * disagree — in both cases we have no basis to call anything cross-org.
 */
export function inferCompanyOrgPrefix(companyAccountIds: string[]): string | null {
  const prefixes = new Set<string>();
  for (const id of companyAccountIds) {
    const p = orgPrefix(id);
    if (p) prefixes.add(p);
  }
  return prefixes.size === 1 ? [...prefixes][0] : null;
}

export interface PickCategoryAccountInput {
  /** Category id then its ancestors, nearest first. */
  chain: string[];
  /** categoryId → account id, already filtered to this company. */
  perEntity: Map<string, string | null>;
  /** categoryId → legacy entity-agnostic expense_categories.zoho_account_id. */
  legacyById: Map<string, string | null>;
  /** Every account id mapped to this company, used to infer its Zoho org. */
  companyAccountIds: string[];
}

/**
 * Resolution order: per-entity map (self → ancestors), then the legacy column
 * (self → ancestors).
 *
 * The legacy column is entity-agnostic, so it can hand one org's account to
 * another org — Zoho rejects that with "Please enter valid expense account".
 * Reject a legacy id only on positive evidence of a mismatch: if the company's
 * org can't be established, behaviour is unchanged. Returning null is the safe
 * outcome — the push then stops in Midas with MISSING_ZOHO_EXPENSE_ACCOUNT,
 * which names the fix, instead of being rejected by Zoho.
 */
export function pickCategoryAccountId(input: PickCategoryAccountInput): string | null {
  const { chain, perEntity, legacyById, companyAccountIds } = input;

  for (const id of chain) {
    const hit = perEntity.get(id);
    if (hit) return hit;
  }

  const companyOrg = inferCompanyOrgPrefix(companyAccountIds);
  for (const id of chain) {
    const legacy = legacyById.get(id);
    if (!legacy) continue;
    if (companyOrg && orgPrefix(legacy) !== companyOrg) return null;
    return legacy;
  }
  return null;
}
