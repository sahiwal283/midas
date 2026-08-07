import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { companies } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';

const router = Router();
router.use(authenticate);

// Active companies for pickers (all authenticated users).
router.get('/', asyncHandler(async (_req, res) => {
  const rows = await db.query.companies.findMany({
    where: eq(companies.isActive, true),
    orderBy: (c, { asc }) => [asc(c.sortOrder), asc(c.name)],
  });
  res.json({ companies: rows.map((c) => ({ id: c.id, name: c.name, zohoEnabled: c.zohoEnabled })) });
}));

export default router;
