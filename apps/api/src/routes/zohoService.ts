import { Router } from 'express';
import { env } from '../config/env';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { checkServiceHealth } from '../lib/zoho';

const router = Router();

router.use(authenticate);

// GET /api/v1/zoho/service-health
// Accountant/admin only. Probes the Zoho Integration Service's /health endpoint and
// reports current Midas Zoho mode. Read-only connectivity check — never touches Zoho,
// never creates a record, never returns the app token.
router.get('/service-health', requireRole('accountant', 'admin'), asyncHandler(async (_req, res) => {
  const service = await checkServiceHealth();
  res.json({
    service,
    zohoMode: env.ZOHO_MODE,
    dryRun: env.ZOHO_DRY_RUN,
    liveWritesEnabled: env.ZOHO_MODE === 'service' && !env.ZOHO_DRY_RUN,
  });
}));

export default router;
