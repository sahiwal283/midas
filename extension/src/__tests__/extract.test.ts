import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractPageData } from '../content/extract';
import {
  describeItems,
  merchantFromUrl,
  parseDateToIso,
  parseMoney,
  resolveField,
} from '../shared/pageData';

function docFrom(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

describe('parseMoney', () => {
  it('parses the common shapes', () => {
    expect(parseMoney('$1,234.56')).toBe(1234.56);
    expect(parseMoney('42.50')).toBe(42.5);
    expect(parseMoney('USD 42.50')).toBe(42.5);
    expect(parseMoney(19.99)).toBe(19.99);
  });

  it('handles European separators by treating the last one as the decimal', () => {
    expect(parseMoney('1.234,56')).toBe(1234.56);
  });

  it('rejects non-money, zero, negatives, and absurd values', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('Order #114-3941689')).toBeNull();
    expect(parseMoney('0.00')).toBeNull();
    expect(parseMoney(-5)).toBeNull();
    expect(parseMoney('99999999.00')).toBeNull();
  });
});

describe('parseDateToIso', () => {
  it('passes ISO through without a timezone round-trip', () => {
    // new Date('2026-03-30') is UTC midnight — formatting it locally west of
    // Greenwich yields the 29th. ISO input must survive untouched.
    expect(parseDateToIso('2026-03-30')).toBe('2026-03-30');
    expect(parseDateToIso('2026-03-30T14:00:00Z')).toBe('2026-03-30');
  });

  it('parses human formats', () => {
    expect(parseDateToIso('March 30, 2026')).toBe('2026-03-30');
    expect(parseDateToIso('3/30/2026')).toBe('2026-03-30');
  });

  it('rejects junk and implausible years', () => {
    expect(parseDateToIso('not a date')).toBeNull();
    expect(parseDateToIso('January 1, 1970')).toBeNull();
  });
});

describe('resolveField precedence', () => {
  it('prefers structured over labeled over site over heuristic', () => {
    const r = resolveField([
      { value: 1, source: 'heuristic' },
      { value: 2, source: 'site' },
      { value: 3, source: 'labeled' },
      { value: 4, source: 'structured' },
    ]);
    expect(r).toEqual({ value: 4, source: 'structured' });
  });

  it('breaks ties within a source by weight', () => {
    const r = resolveField([
      { value: 'total', source: 'labeled', weight: 5 },
      { value: 'order total', source: 'labeled', weight: 10 },
    ]);
    expect(r?.value).toBe('order total');
  });

  it('ignores empty candidates', () => {
    expect(resolveField([{ value: '', source: 'structured' }])).toBeNull();
    expect(resolveField([])).toBeNull();
  });
});

describe('extractPageData — the bugs the old extension had', () => {
  it('does NOT let a struck-through "was" price beat the order total', () => {
    // The replaced extension took Math.max of every price, so $199.99 won.
    const doc = docFrom(`
      <div class="deal"><span>Was $199.99</span><span>Now $24.99</span></div>
      <table><tr><td>Order Total</td><td>$24.99</td></tr></table>
    `);
    const data = extractPageData(doc, 'https://www.example.com/orders/123');
    expect(data.amount?.value).toBe(24.99);
    expect(data.amount?.source).toBe('labeled');
  });

  it('does NOT take the first date on the page when a labeled one exists', () => {
    // Old behaviour grabbed the copyright year's date first.
    const doc = docFrom(`
      <footer>© January 1, 2020 Example Inc</footer>
      <div><span>Order placed</span><span>March 30, 2026</span></div>
    `);
    const data = extractPageData(doc, 'https://www.example.com/orders/123');
    expect(data.date?.value).toBe('2026-03-30');
  });

  it('falls back to the page-max heuristic only when nothing better exists', () => {
    const doc = docFrom(`<p>Some price $12.00 and another $45.00</p>`);
    const data = extractPageData(doc, 'https://shop.example.com/x');
    expect(data.amount?.value).toBe(45);
    expect(data.amount?.source).toBe('heuristic');
  });
});

describe('extractPageData — structured data', () => {
  it('reads a JSON-LD Order and prefers it over on-page text', () => {
    const doc = docFrom(`
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Order',
        orderNumber: 'A-55512',
        orderDate: '2026-03-30',
        totalPaymentDue: { '@type': 'PriceSpecification', value: '42.50' },
        seller: { '@type': 'Organization', name: 'Fontainebleau Las Vegas' },
      })}</script>
      <div>Total $999.00</div>
    `);
    const data = extractPageData(doc, 'https://www.example.com/receipt');
    expect(data.amount).toEqual({ value: 42.5, source: 'structured' });
    expect(data.merchant?.value).toBe('Fontainebleau Las Vegas');
    expect(data.date?.value).toBe('2026-03-30');
    expect(data.reference?.value).toBe('A-55512');
  });

  it('prefers an Order total over a Product price on the same page', () => {
    const doc = docFrom(`
      <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Widget', offers: { price: '10.00' } })}</script>
      <script type="application/ld+json">${JSON.stringify({ '@type': 'Order', totalPaymentDue: '87.25' })}</script>
    `);
    expect(extractPageData(doc, 'https://x.com').amount?.value).toBe(87.25);
  });

  it('survives a malformed JSON-LD block', () => {
    const doc = docFrom(`
      <script type="application/ld+json">{ not json ]</script>
      <table><tr><td>Order Total</td><td>$5.00</td></tr></table>
    `);
    expect(extractPageData(doc, 'https://x.com').amount?.value).toBe(5);
  });

  it('uses og:site_name for the merchant over the hostname', () => {
    const doc = docFrom(`<meta property="og:site_name" content="Best Buy">`);
    // jsdom puts meta in body here; querySelector still finds it.
    const data = extractPageData(doc, 'https://www.bestbuy.com/x');
    expect(data.merchant?.value).toBe('Best Buy');
  });
});

describe('extractPageData — references and items', () => {
  it('finds an order number from labeled text', () => {
    const doc = docFrom(`<p>Order # 114-3941689-2130668</p>`);
    expect(extractPageData(doc, 'https://amazon.com').reference?.value).toBe('114-3941689-2130668');
  });

  it('falls back to the hostname for the merchant', () => {
    const doc = docFrom(`<p>nothing useful</p>`);
    expect(extractPageData(doc, 'https://www.homedepot.com/cart').merchant?.value).toBe('Homedepot');
  });

  it('returns an empty shape on a page with nothing to offer', () => {
    const data = extractPageData(docFrom('<p>hello</p>'), 'https://blog.example.com/post');
    expect(data.amount).toBeNull();
    expect(data.date).toBeNull();
    expect(data.items).toEqual([]);
  });
});

describe('helpers', () => {
  it('summarizes items compactly', () => {
    expect(describeItems(['A', 'B', 'C', 'D'])).toBe('Items: A, B, +2 more');
    expect(describeItems(['A'])).toBe('Items: A');
    expect(describeItems([])).toBe('');
  });

  it('derives a merchant from a hostname', () => {
    expect(merchantFromUrl('https://www.walmart.com/x')).toBe('Walmart');
    expect(merchantFromUrl('not a url')).toBeNull();
  });
});
