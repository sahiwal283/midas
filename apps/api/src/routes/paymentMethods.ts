import { Router } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index';
import { paymentMethods } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, notFound } from '../middleware/error';
import { auditLog } from '../lib/audit';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  label: z.string().min(1).max(100),
  lastFour: z.string().length(4).regex(/^\d{4}$/).optional(),
  brand: z.enum(['visa', 'mastercard', 'amex', 'discover', 'debit', 'cash', 'other']).optional(),
  zohoAccountName: z.string().optional(),
  defaultZohoEntity: z.string().max(200).optional().nullable(),
  requiresReimbursement: z.boolean().optional(),
  isCompanyWide: z.boolean().default(true),
  assignedUserId: z.string().uuid().optional(),
});

const updateSchema = createSchema.partial().extend({
  isActive: z.boolean().optional(),
});

// List active payment methods — all authenticated users can see company-wide methods
router.get('/', asyncHandler(async (req, res) => {
  const isPrivileged = req.user!.role !== 'user';

  const rows = isPrivileged
    ? await db.query.paymentMethods.findMany({
        where: eq(paymentMethods.isActive, true),
        orderBy: (pm, { asc }) => [asc(pm.label)],
      })
    : await db.query.paymentMethods.findMany({
        where: and(
          eq(paymentMethods.isActive, true),
          eq(paymentMethods.isCompanyWide, true),
        ),
        orderBy: (pm, { asc }) => [asc(pm.label)],
      });

  res.json({ paymentMethods: rows });
}));

// Create — admin only
router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);

  const [pm] = await db.insert(paymentMethods).values({
    ...body,
    lastFour: body.lastFour ?? null,
    brand: body.brand ?? null,
    zohoAccountName: body.zohoAccountName ?? null,
    defaultZohoEntity: body.defaultZohoEntity ?? null,
    requiresReimbursement: body.requiresReimbursement ?? false,
    assignedUserId: body.assignedUserId ?? null,
  }).returning();

  await auditLog({
    entityType: 'payment_method',
    entityId: pm.id,
    userId: req.user!.id,
    action: 'created',
    after: pm,
  });

  res.status(201).json({ paymentMethod: pm });
}));

// Update — admin only
router.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const pm = await db.query.paymentMethods.findFirst({
    where: eq(paymentMethods.id, req.params.id),
  });
  if (!pm) throw notFound('Payment method not found');

  const body = updateSchema.parse(req.body);
  const before = { ...pm };

  const [updated] = await db.update(paymentMethods)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(paymentMethods.id, req.params.id))
    .returning();

  await auditLog({
    entityType: 'payment_method',
    entityId: pm.id,
    userId: req.user!.id,
    action: 'updated',
    before,
    after: updated,
  });

  res.json({ paymentMethod: updated });
}));

export default router;
