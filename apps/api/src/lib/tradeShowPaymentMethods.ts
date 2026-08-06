/**
 * Canonical Trade Show `app_settings.cardOptions` snapshot (prod CT 2320, 2026-08-03).
 * Match key for upsert / expense backfill: lastFour (unique across this catalog).
 */
export type TradeShowCardOption = {
  name: string;
  entity: string | null;
  lastFour: string;
  zohoPaymentAccountId: string | null;
  requiresReimbursement?: boolean;
};

export const TRADE_SHOW_CARD_OPTIONS: TradeShowCardOption[] = [
  {
    name: 'Personal (Need reimbursement)',
    entity: null,
    lastFour: '0000',
    zohoPaymentAccountId: null,
    requiresReimbursement: true,
  },
  { name: 'Haute PNC', entity: 'Haute Brands', lastFour: '3490', zohoPaymentAccountId: '5254962000000129043' },
  { name: 'Boomin PNC', entity: 'Boomin Brands', lastFour: '7458', zohoPaymentAccountId: '4849689000000430009' },
  { name: 'Boomin Capital One', entity: 'Boomin Brands', lastFour: '9330', zohoPaymentAccountId: '4849689000010206091' },
  { name: 'Nirvana PNC', entity: 'Nirvana Kulture', lastFour: '7210', zohoPaymentAccountId: null },
  { name: 'Sameer Summitt Card OLD', entity: 'Summitt Labs', lastFour: '3019', zohoPaymentAccountId: null },
  { name: 'Nirvana PNC', entity: 'Nirvana Kulture', lastFour: '4171', zohoPaymentAccountId: null },
  { name: 'Brett Summitt Card', entity: 'Summitt Labs', lastFour: '1039', zohoPaymentAccountId: null },
  { name: 'Nirvana ACH', entity: 'Nirvana Kulture', lastFour: '8689', zohoPaymentAccountId: null },
  { name: 'Sameer Summitt card', entity: 'Summitt Labs', lastFour: '1096', zohoPaymentAccountId: null },
  { name: 'Nirvana PNC', entity: 'Nirvana Kulture', lastFour: '7466', zohoPaymentAccountId: null },
  { name: 'Haute Amex', entity: 'Haute Brands', lastFour: '1002', zohoPaymentAccountId: '5254962000007040062' },
];

export function inferCardBrand(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes('amex')) return 'amex';
  if (n.includes('visa')) return 'visa';
  if (n.includes('master')) return 'mastercard';
  if (n.includes('discover')) return 'discover';
  if (n.includes('ach') || n.includes('personal') || n.includes('reimbursement')) return 'other';
  if (n.includes('debit')) return 'debit';
  return 'other';
}

/** Extract last-4 from Trade Show cardUsed strings like "Nirvana PNC (...4171)" or "Haute PNC | 3490". */
export function parseCardUsedLastFour(cardUsed: string | null | undefined): string | null {
  if (!cardUsed) return null;
  const paren = cardUsed.match(/\(\.{3}(\d{4})\)/);
  if (paren) return paren[1];
  const pipe = cardUsed.match(/\|\s*(\d{4})\s*$/);
  if (pipe) return pipe[1];
  const trailing = cardUsed.match(/(\d{4})\s*$/);
  if (trailing) return trailing[1];
  return null;
}
