# Trade Show → Midas payment methods

**Date:** 2026-08-03  
**Status:** Midas catalog synced from Trade Show prod `app_settings.cardOptions` (12 cards).  
**To:** Trade Show App agent

---

## What Midas did

1. Added `payment_methods.default_zoho_entity` (Trade Show `entity`).
2. Stored Trade Show `zohoPaymentAccountId` in `payment_methods.zoho_account_name` (Zoho paid-through id).
3. Upserted all **12** cards from Trade Show prod (CT 2320) — no skips.
4. Backfilled `expenses.payment_method_id` for `source_app = trade_show` by matching `source_context.cardUsed` last-4.
5. When expense `zohoEntity` was blank, filled from the card’s entity.
6. New Ext endpoint: **`GET /api/v1/ext/payment-methods`** (scope `expenses:read`).
7. Personal card flagged `requiresReimbursement: true` — expenses auto-enter reimbursement (`pending` / Needs reimbursement).

### Catalog (source of truth snapshot)

| Label | Last 4 | Entity | Zoho payment account ID |
|---|---|---|---|
| Personal (Need reimbursement) | 0000 | — | — |
| Haute PNC | 3490 | Haute Brands | 5254962000000129043 |
| Boomin PNC | 7458 | Boomin Brands | 4849689000000430009 |
| Boomin Capital One | 9330 | Boomin Brands | 4849689000010206091 |
| Nirvana PNC | 7210 | Nirvana Kulture | — |
| Sameer Summitt Card OLD | 3019 | Summitt Labs | — |
| Nirvana PNC | 4171 | Nirvana Kulture | — |
| Brett Summitt Card | 1039 | Summitt Labs | — |
| Nirvana ACH | 8689 | Nirvana Kulture | — |
| Sameer Summitt card | 1096 | Summitt Labs | — |
| Nirvana PNC | 7466 | Nirvana Kulture | — |
| Haute Amex | 1002 | Haute Brands | 5254962000007040062 |

---

## What Trade Show should do next

### A. Prefer Midas payment method UUIDs on write

On create / import / update, send **`paymentMethodId`** (Midas UUID), not only `cardUsed` string.

```http
GET /api/v1/ext/payment-methods
Authorization: Bearer <ext_key>
```

Response shape:

```json
{
  "paymentMethods": [
    {
      "id": "uuid",
      "label": "Haute PNC",
      "lastFour": "3490",
      "brand": "other",
      "defaultZohoEntity": "Haute Brands",
      "zohoPaymentAccountId": "5254962000000129043",
      "zohoAccountName": "5254962000000129043"
    }
  ]
}
```

Match locally by `lastFour` (unique) or `label` + `lastFour`. Cache with short TTL; re-fetch when admin changes cards in Midas.

### B. Keep `cardUsed` in `source_context` (optional but useful)

Continue sending human-readable `cardUsed` (e.g. `Nirvana PNC (...4171)`) for display/audit. Midas already stores it; **authoritative link** is `paymentMethodId`.

### C. Default entity from card

When creating an expense, if entity is unset, set `zohoEntity` from `defaultZohoEntity` on the chosen payment method (same as Trade Show card → entity).

### D. Ongoing sync ownership

**Midas is SoR for payment methods going forward.** Options:

1. **Recommended:** Admins edit cards in Midas UI (`/payment-methods`). Trade Show reads via Ext and stops owning `cardOptions` as SoR (or mirrors read-only).
2. **Interim:** If Trade Show still edits `cardOptions`, notify Midas / re-run  
   `npx tsx src/scripts/sync-trade-show-payment-methods.ts` after changes (or add a future Ext upsert — not built yet).

### E. Scope note

`GET /payment-methods` uses existing scope **`expenses:read`** (same as categories). No new scope required.

---

## Re-sync command (Midas ops)

```bash
# on CT 3120 API container
docker exec -w /app/apps/api midas-api-1 npx tsx src/scripts/sync-trade-show-payment-methods.ts
# dry-run:
docker exec -w /app/apps/api midas-api-1 npx tsx src/scripts/sync-trade-show-payment-methods.ts --dry-run
```

Schema: `apps/api/drizzle/0003_payment_method_entity.sql`.
