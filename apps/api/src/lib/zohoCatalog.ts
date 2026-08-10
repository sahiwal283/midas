import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/index';
import { vendors, zohoItems } from '../db/schema';
import { normalizeMerchant } from './merchants';
import { zoho, type ZohoItem, type ZohoVendor } from './zoho';
import { env } from '../config/env';
import { logger } from './logger';

export async function syncZohoVendorsToCache(brand = env.ZOHO_DEFAULT_BRAND): Promise<ZohoVendor[]> {
  const list = await zoho.listVendors(brand);
  const now = new Date();
  for (const v of list) {
    const normalizedName = normalizeMerchant(v.vendorName).toLowerCase();
    const existing = await db.query.vendors.findFirst({
      where: eq(vendors.zohoVendorId, v.vendorId),
    });
    if (existing) {
      await db.update(vendors)
        .set({
          name: v.companyName || v.vendorName,
          normalizedName,
          isActive: true,
          updatedAt: now,
        })
        .where(eq(vendors.id, existing.id));
    } else {
      // Prefer match by normalized name if no zoho id yet
      const byName = await db.query.vendors.findFirst({
        where: eq(vendors.normalizedName, normalizedName),
      });
      if (byName) {
        await db.update(vendors)
          .set({ zohoVendorId: v.vendorId, name: v.companyName || v.vendorName, updatedAt: now })
          .where(eq(vendors.id, byName.id));
      } else {
        await db.insert(vendors).values({
          name: v.companyName || v.vendorName,
          normalizedName,
          zohoVendorId: v.vendorId,
          defaultEntity: null,
        });
      }
    }
  }
  return list;
}

export async function syncZohoItemsToCache(brand = env.ZOHO_DEFAULT_BRAND): Promise<ZohoItem[]> {
  const list = await zoho.listItems(brand);
  const now = new Date();
  for (const item of list) {
    await db.insert(zohoItems)
      .values({
        zohoItemId: item.itemId,
        name: item.name,
        sku: item.sku ?? null,
        unit: item.unit ?? null,
        brand,
        isActive: true,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [zohoItems.brand, zohoItems.zohoItemId],
        set: {
          name: item.name,
          sku: item.sku ?? null,
          unit: item.unit ?? null,
          isActive: true,
          syncedAt: now,
        },
      });
  }
  return list;
}

export async function cachedVendorsAsZohoShape(): Promise<ZohoVendor[]> {
  const rows = await db.query.vendors.findMany({
    where: and(isNotNull(vendors.zohoVendorId), eq(vendors.isActive, true)),
  });
  return rows
    .filter((r): r is typeof r & { zohoVendorId: string } => Boolean(r.zohoVendorId))
    .map((r) => ({
      vendorId: r.zohoVendorId,
      vendorName: r.name,
      companyName: r.name,
    }));
}

export async function cachedItemsAsZohoShape(brand = env.ZOHO_DEFAULT_BRAND): Promise<ZohoItem[]> {
  const rows = await db.query.zohoItems.findMany({
    where: and(eq(zohoItems.brand, brand), eq(zohoItems.isActive, true)),
  });
  return rows.map((r) => ({
    itemId: r.zohoItemId,
    name: r.name,
    sku: r.sku,
    unit: r.unit,
  }));
}

/** Live list with cache write-through; falls back to cache on Zoho failure. */
export async function listVendorsWithCache(brand = env.ZOHO_DEFAULT_BRAND): Promise<{
  vendors: ZohoVendor[];
  source: 'live' | 'cache';
}> {
  try {
    const vendorsList = await syncZohoVendorsToCache(brand);
    return { vendors: vendorsList, source: 'live' };
  } catch (err) {
    logger.warn({ err }, 'Zoho vendors live list failed — serving cache');
    return { vendors: await cachedVendorsAsZohoShape(), source: 'cache' };
  }
}

export async function listItemsWithCache(brand = env.ZOHO_DEFAULT_BRAND): Promise<{
  items: ZohoItem[];
  source: 'live' | 'cache';
}> {
  try {
    const items = await syncZohoItemsToCache(brand);
    return { items, source: 'live' };
  } catch (err) {
    logger.warn({ err }, 'Zoho items live list failed — serving cache');
    return { items: await cachedItemsAsZohoShape(brand), source: 'cache' };
  }
}
