/**
 * Zoho integration smoke (safe by default).
 *
 * Checks vendor/item list + PO payload shaping. Does NOT create Books POs
 * unless ZOHO_SMOKE_WRITE=1 (still requires a real vendor_id + item_id).
 *
 *   npm run zoho:smoke -w @midas/api
 *   ZOHO_SMOKE_WRITE=1 npm run zoho:smoke -w @midas/api
 */
import { env } from '../config/env';
import { zoho } from '../lib/zoho';
import { toZohoBooksPoCreateBody, type ZohoPoServicePayload } from '../lib/zohoPoPayload';
import { listItemsWithCache, listVendorsWithCache } from '../lib/zohoCatalog';

async function main() {
  const brand = env.ZOHO_DEFAULT_BRAND;
  const steps: Array<{ name: string; ok: boolean; detail: string }> = [];

  console.log(`ZOHO_MODE=${env.ZOHO_MODE} brand=${brand}`);

  try {
    const vendors = await listVendorsWithCache(brand);
    steps.push({
      name: 'list vendors (+ cache)',
      ok: Array.isArray(vendors.vendors),
      detail: `source=${vendors.source} count=${vendors.vendors.length}`,
    });
  } catch (err) {
    steps.push({
      name: 'list vendors (+ cache)',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const items = await listItemsWithCache(brand);
    steps.push({
      name: 'list items (+ cache)',
      ok: Array.isArray(items.items),
      detail: `source=${items.source} count=${items.items.length}`,
    });
  } catch (err) {
    steps.push({
      name: 'list items (+ cache)',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const sample: ZohoPoServicePayload = {
    idempotencyKey: `smoke-${Date.now()}`,
    transactionId: '00000000-0000-4000-8000-000000000099',
    vendor: { name: 'Smoke Vendor', zohoVendorId: 'vendor-smoke' },
    date: new Date().toISOString().slice(0, 10),
    currency: 'USD',
    taxTotal: '0',
    total: '10.00',
    brand,
    zohoEntity: null,
    lineItems: [{
      lineNumber: 1,
      description: 'Smoke line',
      quantity: '1',
      unit: 'qty',
      unitPrice: '10.00',
      tax: '0',
      total: '10.00',
      zohoItemId: 'item-smoke',
    }],
    receipt: null,
    source: { app: 'midas', type: 'smoke', id: null, url: null, label: null },
  };

  try {
    const body = toZohoBooksPoCreateBody(sample);
    const ok = Boolean(body.vendor_id && body.line_items?.[0]?.item_id && body.idempotencyKey);
    steps.push({
      name: 'shape Books PO body',
      ok,
      detail: ok
        ? `keys=${Object.keys(body).sort().join(',')}`
        : 'missing vendor_id or line_items',
    });
  } catch (err) {
    steps.push({
      name: 'shape Books PO body',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (process.env.ZOHO_SMOKE_WRITE === '1') {
    const vendorId = process.env.ZOHO_SMOKE_VENDOR_ID;
    const itemId = process.env.ZOHO_SMOKE_ITEM_ID;
    if (!vendorId || !itemId) {
      steps.push({
        name: 'write PO (skipped)',
        ok: false,
        detail: 'Set ZOHO_SMOKE_VENDOR_ID and ZOHO_SMOKE_ITEM_ID',
      });
    } else {
      try {
        const writePayload: ZohoPoServicePayload = {
          ...sample,
          vendor: { name: 'Smoke Vendor', zohoVendorId: vendorId },
          lineItems: [{ ...sample.lineItems[0]!, zohoItemId: itemId }],
        };
        // Ensure payload shapes to Books body before live push.
        toZohoBooksPoCreateBody(writePayload);
        const result = await zoho.pushPurchaseOrder(writePayload);
        steps.push({
          name: 'write PO',
          ok: Boolean(result?.zohoPurchaseOrderId),
          detail: JSON.stringify(result).slice(0, 200),
        });
      } catch (err) {
        steps.push({
          name: 'write PO',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    steps.push({
      name: 'write PO',
      ok: true,
      detail: 'skipped (set ZOHO_SMOKE_WRITE=1 to create)',
    });
  }

  let failed = 0;
  for (const s of steps) {
    const mark = s.ok ? 'ok' : 'FAIL';
    console.log(`[${mark}] ${s.name} — ${s.detail}`);
    if (!s.ok) failed += 1;
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
