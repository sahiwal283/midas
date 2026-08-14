import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { vendors } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, createError } from '../middleware/error';
import { zoho } from '../lib/zoho';
import { vendorKey } from '../lib/vendorMatch';
import { listVendorsWithCache } from '../lib/zohoCatalog';
import { resolveBrandFromEntity } from '../lib/zohoBrand';
import { env } from '../config/env';
import { auditLog } from '../lib/audit';

const router = Router();
router.use(authenticate);

function brandFor(zohoEntity: string | undefined): string {
  return (zohoEntity && resolveBrandFromEntity(zohoEntity)) || env.ZOHO_DEFAULT_BRAND;
}

// GET /api/v1/vendors?zohoEntity=Haute%20Brands
// Vendor list for pickers — live from Zoho with DB-cache fallback.
router.get('/', asyncHandler(async (req, res) => {
  const zohoEntity = typeof req.query.zohoEntity === 'string' ? req.query.zohoEntity.trim() : '';
  const { vendors: list, source } = await listVendorsWithCache(brandFor(zohoEntity || undefined));
  res.json({
    vendors: list.map((v) => ({ vendorId: v.vendorId, vendorName: v.companyName || v.vendorName })),
    source,
  });
}));

// POST /api/v1/vendors { name, zohoEntity? }
// Create a vendor in Zoho Books — with duplicate detection: if the normalized
// name (case, punctuation, processor decorations) already exists, the existing
// vendor is returned instead of creating a twin.
router.post('/', asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1).max(200),
    zohoEntity: z.string().max(200).optional(),
  }).parse(req.body);
  const name = body.name.trim();
  if (!name) throw createError('Vendor name is required', 400, 'MISSING_NAME');
  const brand = brandFor(body.zohoEntity);

  // Refresh the cache first (best-effort) so dedup sees vendors created
  // outside Midas; on Zoho failure we still dedup against the last sync.
  const { vendors: list } = await listVendorsWithCache(brand);
  const key = vendorKey(name);
  const existingLive = list.find((v) => vendorKey(v.companyName || v.vendorName) === key);
  if (existingLive) {
    res.json({
      vendor: { vendorId: existingLive.vendorId, vendorName: existingLive.companyName || existingLive.vendorName },
      existed: true,
    });
    return;
  }
  const existingCached = await db.query.vendors.findFirst({ where: eq(vendors.normalizedName, key) });
  if (existingCached?.zohoVendorId) {
    res.json({
      vendor: { vendorId: existingCached.zohoVendorId, vendorName: existingCached.name },
      existed: true,
    });
    return;
  }

  const created = await zoho.createVendor(name, brand);
  await db.insert(vendors)
    .values({ name: created.vendorName, normalizedName: key, zohoVendorId: created.vendorId })
    .onConflictDoUpdate({
      target: vendors.normalizedName,
      set: { zohoVendorId: created.vendorId, name: created.vendorName, isActive: true, updatedAt: new Date() },
    });
  await auditLog({
    entityType: 'vendor',
    entityId: created.vendorId,
    userId: req.user!.id,
    action: 'vendor_created_in_zoho',
    after: { name: created.vendorName, brand },
  });

  res.status(201).json({
    vendor: { vendorId: created.vendorId, vendorName: created.vendorName },
    existed: false,
  });
}));

export default router;
