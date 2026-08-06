import { Router } from 'express';
import { env } from '../config/env';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, createError } from '../middleware/error';
import { checkServiceHealth, checkZohoAuth, listExpenseAccounts, ZohoServiceError } from '../lib/zoho';
import { listZohoEntities, resolveBrandFromEntity } from '../lib/zohoBrand';

const router = Router();

router.use(authenticate);

// GET /api/v1/zoho/service-health
// Accountant/admin only. Probes the Zoho Integration Service's /health endpoint,
// optionally Zoho org auth (read-only), and reports current Midas Zoho mode.
// Never creates a Zoho record; never returns the app token.
router.get('/service-health', requireRole('accountant', 'admin'), asyncHandler(async (_req, res) => {
  const [service, zohoAuth] = await Promise.all([checkServiceHealth(), checkZohoAuth()]);
  const liveWritesEnabled = env.ZOHO_MODE === 'service' && !env.ZOHO_DRY_RUN;
  res.json({
    service,
    zohoAuth,
    zohoMode: env.ZOHO_MODE,
    dryRun: env.ZOHO_DRY_RUN,
    brand: env.ZOHO_DEFAULT_BRAND,
    liveWritesEnabled,
    // True only when Midas would actually POST and the service can talk to Zoho.
    readyForLivePush: liveWritesEnabled && service.ok && zohoAuth.ok,
  });
}));

// GET /api/v1/zoho/entities
// Known accounting entities (brand mapping) for the New Expense / review pickers.
router.get('/entities', asyncHandler(async (_req, res) => {
  res.json({ entities: listZohoEntities() });
}));

// GET /api/v1/zoho/expense-accounts?zohoEntity=Haute%20Brands
// Live Zoho Books expense accounts for the entity's brand. Not stored in Midas.
router.get('/expense-accounts', asyncHandler(async (req, res) => {
  const zohoEntity = typeof req.query.zohoEntity === 'string' ? req.query.zohoEntity.trim() : '';
  const brandParam = typeof req.query.brand === 'string' ? req.query.brand.trim() : '';
  const brand = brandParam || resolveBrandFromEntity(zohoEntity);
  if (!brand) {
    throw createError(
      'Select a known accounting entity (e.g. Haute Brands) to load expense accounts',
      400,
      'MISSING_ZOHO_ENTITY',
    );
  }

  try {
    const accounts = await listExpenseAccounts(brand);
    res.json({
      zohoEntity: zohoEntity || null,
      brand,
      accounts,
    });
  } catch (err) {
    if (err instanceof ZohoServiceError) {
      const message = err.code === 'ZOHO_AUTH_FORBIDDEN'
        ? `Midas is not granted Zoho access for brand "${brand}". Contact the Zoho Integration Service team.`
        : err.message;
      res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
        error: { code: err.code, message, requestId: err.requestId ?? undefined },
      });
      return;
    }
    throw err;
  }
}));

export default router;
