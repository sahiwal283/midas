import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { budgets } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, createError, notFound } from '../middleware/error';
import { assertActiveCompany } from '../lib/companies';
import { auditLog } from '../lib/audit';

const router = Router();
router.use(authenticate, requireRole('accountant', 'admin'));

const PERIOD_RE = /^\d{4}-\d{2}$/;

const upsertSchema = z.object({
  companyName: z.string().min(1),
  period: z.string().regex(PERIOD_RE, 'period must be YYYY-MM'),
  amount: z.coerce.number().nonnegative(),
  categoryId: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.get('/', asyncHandler(async (req, res) => {
  const period = typeof req.query.period === 'string' && PERIOD_RE.test(req.query.period)
    ? req.query.period
    : undefined;
  const company = typeof req.query.company === 'string' && req.query.company.trim()
    ? req.query.company.trim()
    : undefined;
  const conds = [];
  if (period) conds.push(eq(budgets.period, period));
  if (company) conds.push(eq(budgets.companyName, company));

  const rows = await db.query.budgets.findMany({
    where: conds.length ? and(...conds) : undefined,
    with: { category: { columns: { id: true, name: true } } },
    orderBy: [desc(budgets.period), budgets.companyName],
  });
  res.json({ budgets: rows });
}));

router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const body = upsertSchema.parse(req.body);
  const companyName = await assertActiveCompany(body.companyName);
  if (!companyName) throw createError('companyName is required', 400, 'MISSING_COMPANY');

  try {
    const [row] = await db.insert(budgets).values({
      companyName,
      period: body.period,
      amount: String(body.amount),
      categoryId: body.categoryId ?? null,
      notes: body.notes ?? null,
    }).returning();
    await auditLog({
      entityType: 'budget',
      entityId: row.id,
      userId: req.user!.id,
      action: 'budget.created',
      after: row,
    });
    res.status(201).json({ budget: row });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      throw createError('A budget already exists for this company/period/category', 409, 'BUDGET_EXISTS');
    }
    throw err;
  }
}));

router.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const existing = await db.query.budgets.findFirst({ where: eq(budgets.id, req.params.id) });
  if (!existing) throw notFound('Budget not found');
  const body = upsertSchema.partial().parse(req.body);

  let companyName = existing.companyName;
  if (body.companyName !== undefined) {
    const c = await assertActiveCompany(body.companyName);
    if (!c) throw createError('companyName is required', 400, 'MISSING_COMPANY');
    companyName = c;
  }

  const [row] = await db.update(budgets)
    .set({
      companyName,
      period: body.period ?? existing.period,
      amount: body.amount !== undefined ? String(body.amount) : existing.amount,
      categoryId: body.categoryId !== undefined ? body.categoryId : existing.categoryId,
      notes: body.notes !== undefined ? body.notes : existing.notes,
      updatedAt: new Date(),
    })
    .where(eq(budgets.id, existing.id))
    .returning();

  await auditLog({
    entityType: 'budget',
    entityId: row.id,
    userId: req.user!.id,
    action: 'budget.updated',
    before: existing,
    after: row,
  });
  res.json({ budget: row });
}));

router.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const existing = await db.query.budgets.findFirst({ where: eq(budgets.id, req.params.id) });
  if (!existing) throw notFound('Budget not found');
  await db.delete(budgets).where(eq(budgets.id, existing.id));
  await auditLog({
    entityType: 'budget',
    entityId: existing.id,
    userId: req.user!.id,
    action: 'budget.deleted',
    before: existing,
  });
  res.json({ ok: true });
}));

export default router;
