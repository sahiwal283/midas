/**
 * Merchant name normalization for reporting (pure — no env/db imports).
 *
 * Card processors decorate merchant names ("AMAZON.COM*1A2B3C", "SQ *COFFEE
 * SHOP", "WAL-MART #1234"), so naive GROUP BY splits one vendor into many.
 * normalizeMerchant collapses those variants into one display label.
 *
 * Pipeline: lowercase → strip processor prefixes/suffixes → strip punctuation
 * → drop corporate tails (.com/inc/llc) → alias map → Title Case.
 */

/** Fully-normalized key → canonical name (applied after punctuation stripping). */
const ALIASES: Record<string, string> = {
  'amzn': 'amazon',
  'amzn mktp': 'amazon',
  'amzn mktp us': 'amazon',
  'wal mart': 'walmart',
  'mcdonald s': 'mcdonalds',
};

const CORPORATE_TAIL_RE = /\s+(com|inc|llc)$/;

export function normalizeMerchant(raw: string): string {
  let s = raw.toLowerCase().trim();

  // Square prefixes ("SQ *COFFEE SHOP") — must run before star-suffix stripping,
  // because here the star precedes the real name.
  s = s.replace(/^sq\s*\*\s*/, '').replace(/^sq\s+/, '');

  // Processor star/hash suffixes: 'amazon.com*1a2b3' → 'amazon.com'
  s = s.replace(/[*#].*$/, '');

  // Punctuation → spaces, collapse runs
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();

  // Drop corporate tails repeatedly ('amazon com', 'acme co inc' → base name)
  let prev: string;
  do {
    prev = s;
    s = s.replace(CORPORATE_TAIL_RE, '').trim();
  } while (s !== prev);

  s = ALIASES[s] ?? s;

  if (!s) return raw.trim();

  // Title Case for display
  return s
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
