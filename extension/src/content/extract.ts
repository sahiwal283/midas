// Reads order/receipt data out of the current page.
//
// Resolution order (see shared/pageData.ts): structured data → labeled totals
// → site adapters → generic heuristics. The old extension this replaces took
// Math.max over every price on the page, which loses to struck-through "was"
// prices and unrelated items; labeled and structured values are preferred here
// and the page-max heuristic is the last resort.
//
// Exported functions take a Document so they can be unit-tested with jsdom.

import {
  describeItems,
  merchantFromUrl,
  parseDateToIso,
  parseMoney,
  resolveField,
  type FieldCandidate,
  type PageData,
} from '../shared/pageData';

const MONEY_RE = /(?:USD\s*)?\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/;
const MONEY_RE_G = new RegExp(MONEY_RE.source, 'g');

/** Labels that mark the grand total, strongest first. */
const TOTAL_LABELS = [
  { re: /\b(?:order|grand)\s+total\b/i, weight: 10 },
  { re: /\btotal\s+(?:charged|paid|amount)\b/i, weight: 9 },
  { re: /\bamount\s+(?:paid|due|charged)\b/i, weight: 8 },
  { re: /\bpayment\s+total\b/i, weight: 8 },
  { re: /\btotal\b/i, weight: 5 },
];

/** Labels next to the transaction date. */
const DATE_LABELS = [
  { re: /\border\s+(?:placed|date)\b/i, weight: 10 },
  { re: /\b(?:invoice|receipt|purchase|transaction)\s+date\b/i, weight: 9 },
  { re: /\bdate\s+of\s+(?:purchase|order)\b/i, weight: 8 },
  { re: /\bplaced\s+on\b/i, weight: 8 },
];

const REFERENCE_PATTERNS = [
  /\border\s*(?:#|number|no\.?|id)?\s*:?\s*([A-Z0-9][\w-]{4,})/i,
  /\binvoice\s*(?:#|number|no\.?)?\s*:?\s*([A-Z0-9][\w-]{3,})/i,
  /\breceipt\s*(?:#|number|no\.?)?\s*:?\s*([A-Z0-9][\w-]{3,})/i,
  /\bconfirmation\s*(?:#|number|code)?\s*:?\s*([A-Z0-9][\w-]{4,})/i,
];

const DATE_TEXT_RE =
  /\b(\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/;

// ── Structured data (JSON-LD, microdata, Open Graph) ──────────────────────────

function jsonLdNodes(doc: Document): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    out.push(obj);
    // @graph and nested offers/orderedItem carry the useful fields.
    for (const key of ['@graph', 'offers', 'orderedItem', 'itemOffered', 'acceptedOffer']) {
      if (obj[key]) walk(obj[key]);
    }
  };
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    try {
      walk(JSON.parse(el.textContent ?? ''));
    } catch {
      // A malformed block on one page shouldn't kill extraction.
    }
  });
  return out;
}

function structuredCandidates(doc: Document): {
  amount: FieldCandidate<number>[];
  date: FieldCandidate<string>[];
  merchant: FieldCandidate<string>[];
  reference: FieldCandidate<string>[];
  items: string[];
} {
  const amount: FieldCandidate<number>[] = [];
  const date: FieldCandidate<string>[] = [];
  const merchant: FieldCandidate<string>[] = [];
  const reference: FieldCandidate<string>[] = [];
  const items: string[] = [];

  for (const node of jsonLdNodes(doc)) {
    const type = String(node['@type'] ?? '').toLowerCase();
    const isOrder = type.includes('order') || type.includes('invoice');

    const price = node.totalPaymentDue ?? node.price ?? node.total ?? node.totalPrice;
    const priceValue =
      price && typeof price === 'object'
        ? (price as Record<string, unknown>).value ?? (price as Record<string, unknown>).price
        : price;
    const money = parseMoney(priceValue as string | number);
    // An Order's total outranks a Product's price on the same page.
    if (money != null) amount.push({ value: money, source: 'structured', weight: isOrder ? 10 : 5 });

    const when = node.orderDate ?? node.datePublished ?? node.paymentDueDate ?? node.dateCreated;
    const iso = parseDateToIso(when as string);
    if (iso) date.push({ value: iso, source: 'structured', weight: isOrder ? 10 : 5 });

    const seller = node.seller ?? node.merchant ?? node.provider ?? node.brand;
    const sellerName =
      seller && typeof seller === 'object' ? (seller as Record<string, unknown>).name : seller;
    if (typeof sellerName === 'string' && sellerName.trim()) {
      merchant.push({ value: sellerName.trim(), source: 'structured', weight: isOrder ? 10 : 5 });
    }

    const orderNo = node.orderNumber ?? node.confirmationNumber ?? node.identifier;
    if (typeof orderNo === 'string' && orderNo.trim()) {
      reference.push({ value: orderNo.trim(), source: 'structured' });
    }

    if (typeof node.name === 'string' && (type.includes('product') || node.orderedItem)) {
      items.push(node.name);
    }
  }

  // Microdata / Open Graph price fallbacks.
  const metaPrice =
    doc.querySelector('meta[property="product:price:amount"]')?.getAttribute('content') ??
    doc.querySelector('[itemprop="price"]')?.getAttribute('content') ??
    doc.querySelector('[itemprop="price"]')?.textContent;
  const metaMoney = parseMoney(metaPrice);
  if (metaMoney != null) amount.push({ value: metaMoney, source: 'structured', weight: 3 });

  const ogSite = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
  if (ogSite?.trim()) merchant.push({ value: ogSite.trim(), source: 'structured', weight: 3 });

  return { amount, date, merchant, reference, items };
}

// ── Labeled values ────────────────────────────────────────────────────────────

/**
 * Money that sits next to a total-ish label. Scans leaf elements so the match
 * is local — walking the whole body text would let a distant price attach to
 * the label.
 */
function labeledAmountCandidates(doc: Document): FieldCandidate<number>[] {
  const out: FieldCandidate<number>[] = [];
  const nodes = Array.from(doc.querySelectorAll('td, th, span, div, p, li, dt, dd, strong, b'));

  for (const el of nodes) {
    // Leaf-ish only: a wrapper's text includes every child, which defeats locality.
    if (el.children.length > 3) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 120) continue;

    const label = TOTAL_LABELS.find((l) => l.re.test(text));
    if (!label) continue;

    // Money in the same element, else the next sibling / parent's next cell.
    let money = parseMoney(text.match(MONEY_RE)?.[1] ?? null);
    if (money == null) {
      const sibling = el.nextElementSibling?.textContent ?? '';
      money = parseMoney(sibling.match(MONEY_RE)?.[1] ?? null);
    }
    if (money == null) {
      const cousin = el.parentElement?.nextElementSibling?.textContent ?? '';
      money = parseMoney(cousin.match(MONEY_RE)?.[1] ?? null);
    }
    if (money != null) out.push({ value: money, source: 'labeled', weight: label.weight });
  }
  return out;
}

function labeledDateCandidates(doc: Document): FieldCandidate<string>[] {
  const out: FieldCandidate<string>[] = [];
  const nodes = Array.from(doc.querySelectorAll('td, th, span, div, p, li, dt, dd'));

  for (const el of nodes) {
    if (el.children.length > 3) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 160) continue;

    const label = DATE_LABELS.find((l) => l.re.test(text));
    if (!label) continue;

    let iso = parseDateToIso(text.match(DATE_TEXT_RE)?.[1] ?? null);
    if (!iso) {
      const sibling = el.nextElementSibling?.textContent ?? '';
      iso = parseDateToIso(sibling.match(DATE_TEXT_RE)?.[1] ?? null);
    }
    if (iso) out.push({ value: iso, source: 'labeled', weight: label.weight });
  }
  return out;
}

// ── Site adapters ─────────────────────────────────────────────────────────────

/** Amazon order-details and product pages — the one page shape worth special-casing. */
function amazonCandidates(doc: Document, url: string): {
  amount: FieldCandidate<number>[];
  items: string[];
} {
  const amount: FieldCandidate<number>[] = [];
  const items: string[] = [];
  if (!/amazon\./i.test(url)) return { amount, items };

  const grand = doc.querySelector('#grand-total-price, [data-testid="grand-total-price"]');
  const grandMoney = parseMoney(grand?.textContent?.match(MONEY_RE)?.[1] ?? null);
  if (grandMoney != null) amount.push({ value: grandMoney, source: 'site', weight: 10 });

  const offscreen = doc.querySelector('.a-price .a-offscreen');
  const offscreenMoney = parseMoney(offscreen?.textContent?.match(MONEY_RE)?.[1] ?? null);
  if (offscreenMoney != null) amount.push({ value: offscreenMoney, source: 'site', weight: 4 });

  doc.querySelectorAll('[data-component="line-item-component"] a').forEach((a) => {
    const name = a.textContent?.trim();
    if (name) items.push(name);
  });
  const title = doc.querySelector('#productTitle')?.textContent?.trim();
  if (title) items.push(title);

  return { amount, items };
}

// ── Generic heuristics (last resort) ──────────────────────────────────────────

function heuristicAmount(bodyText: string): FieldCandidate<number>[] {
  const matches = bodyText.match(MONEY_RE_G);
  if (!matches?.length) return [];
  // Largest value on the page — the weakest possible signal, hence 'heuristic'.
  // Only ever used when nothing labeled or structured was found.
  const amounts = matches.map((m) => parseMoney(m)).filter((n): n is number => n != null);
  if (!amounts.length) return [];
  return [{ value: Math.max(...amounts), source: 'heuristic' }];
}

function referenceCandidates(bodyText: string): FieldCandidate<string>[] {
  for (const re of REFERENCE_PATTERNS) {
    const m = bodyText.match(re);
    if (m?.[1]) return [{ value: m[1].trim(), source: 'labeled' }];
  }
  return [];
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function extractPageData(doc: Document, url: string): PageData {
  const bodyText = (doc.body?.innerText ?? doc.body?.textContent ?? '').replace(/\s+/g, ' ');
  const structured = structuredCandidates(doc);
  const amazon = amazonCandidates(doc, url);

  const amount = resolveField<number>([
    ...structured.amount,
    ...labeledAmountCandidates(doc),
    ...amazon.amount,
    ...heuristicAmount(bodyText),
  ]);

  const date = resolveField<string>([...structured.date, ...labeledDateCandidates(doc)]);

  const urlMerchant = merchantFromUrl(url);
  const merchant = resolveField<string>([
    ...structured.merchant,
    ...(urlMerchant ? [{ value: urlMerchant, source: 'heuristic' as const }] : []),
  ]);

  const reference = resolveField<string>([
    ...structured.reference,
    ...referenceCandidates(bodyText),
  ]);

  const items = [...new Set([...structured.items, ...amazon.items])].slice(0, 10);

  return { merchant, amount, date, reference, items, pageUrl: url };
}

export { describeItems };
