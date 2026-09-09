/**
 * Match an OCR-extracted line description to a Zoho catalogue item.
 *
 * Runs client-side over the catalogue the PO form already fetches, so matching
 * costs no extra round trip. Lives here rather than in the web app so it is
 * unit-testable and available to the API if server-side matching is ever wanted.
 *
 * Deliberately conservative: a Zoho purchase order is a real financial record,
 * and a wrong silent match is worse than asking the user to pick. Anything below
 * ZOHO_ITEM_MATCH_THRESHOLD returns null so the UI shows "pick an item".
 */

export interface MatchableZohoItem {
  itemId: string;
  name: string;
  sku?: string | null;
}

export interface ZohoItemMatch {
  itemId: string;
  name: string;
  /** 0..1. 1 means an exact normalized name or SKU hit. */
  score: number;
}

export const ZOHO_ITEM_MATCH_THRESHOLD = 0.6;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(value: string): string[] {
  const normalized = normalize(value);
  return normalized ? normalized.split(' ') : [];
}

/**
 * The shortest SKU we will accept as a match on its own. A SKU of two or three
 * characters ('DR', 'EA', 'SET') is indistinguishable from an ordinary word in
 * a free-text line description, and a hit scores a full 1 — outranking every
 * genuine name match. Four characters is short enough to keep real SKUs
 * (`DRAY-01`, `CARPET-1010`) working and long enough that an accidental
 * collision is unlikely. Counted over alphanumerics only, so the separators a
 * SKU uses do not buy it length.
 */
const MIN_SKU_MATCH_LENGTH = 4;

/**
 * Whether the description carries this SKU as a whole token run rather than as
 * a bare substring. `includes` alone matches 'DR' inside 'Dry ice', which is
 * exactly the confident-but-wrong match this module exists to avoid.
 */
function carriesSku(normalizedDescription: string, normalizedSku: string): boolean {
  if (normalizedSku.replace(/ /g, '').length < MIN_SKU_MATCH_LENGTH) return false;
  return ` ${normalizedDescription} `.includes(` ${normalizedSku} `);
}

/**
 * Weighted overlap: what fraction of the catalogue item's own words the
 * description covers, blended with how much of the description was used.
 * Favours the description naming the item over merely being long.
 *
 * Hits are counted over the item's *distinct* words. Counting repeats let a
 * name like 'Carpet carpet carpet' produce more hits than it has words,
 * pushing the result past 1 ("matched 160%") and above a genuine exact match.
 * Deduplicated, a hit is one distinct word on each side, so it can exceed
 * neither denominator and the score stays within 0..1 by construction.
 */
function overlapScore(descriptionTokens: string[], itemTokens: string[]): number {
  if (!descriptionTokens.length || !itemTokens.length) return 0;
  const described = new Set(descriptionTokens);
  const distinctItemTokens = [...new Set(itemTokens)];
  const hits = distinctItemTokens.filter((t) => described.has(t)).length;
  if (!hits) return 0;
  const coverage = hits / distinctItemTokens.length;
  const precision = hits / descriptionTokens.length;
  return coverage * 0.7 + precision * 0.3;
}

export function matchZohoItem(
  description: string,
  items: MatchableZohoItem[],
): ZohoItemMatch | null {
  const normalizedDescription = normalize(description);
  if (!normalizedDescription || !items.length) return null;

  const descriptionTokens = tokens(description);
  let best: ZohoItemMatch | null = null;

  for (const item of items) {
    const normalizedName = normalize(item.name);
    const normalizedSku = item.sku ? normalize(item.sku) : '';

    let score: number;
    if (normalizedName && normalizedName === normalizedDescription) {
      score = 1;
    } else if (normalizedSku && carriesSku(normalizedDescription, normalizedSku)) {
      score = 1;
    } else {
      score = overlapScore(descriptionTokens, tokens(item.name));
    }

    if (score >= ZOHO_ITEM_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { itemId: item.itemId, name: item.name, score };
    }
  }

  return best;
}
