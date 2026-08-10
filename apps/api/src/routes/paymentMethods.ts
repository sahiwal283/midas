import { Router } from 'express';
import { z } from 'zod';
import { eq, and, or } from 'drizzle-orm';
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
  assignedUserId: z.string().uuid().nullable().optional(),
});

const updateSchema = createSchema.partial().extend({
  isActive: z.boolean().optional(),
});

// List active payment methods — non-privileged users see company-wide methods
// plus any card assigned specifically to them.
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
          or(
            eq(paymentMethods.isCompanyWide, true),
            eq(paymentMethods.assignedUserId, req.user!.id),
          ),
        ),
        orderBy: (pm, { asc }) => [asc(pm.label)],
      });

  res.json({ paymentMethods: rows });
}));

// Create — accountant/admin
router.post('/', requireRole('accountant', 'admin'), asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);

  const [pm] = await db.insert(paymentMethods).values({
    ...body,
    lastFour: body.lastFour ?? null,
    brand: body.brand ?? null,
    zohoAccountName: body.zohoAccountName ?? null,
    defaultZohoEntity: body.defaultZohoEntity ?? null,
    requiresReimbursement: body.requiresReimbursement ?? false,
    // Invariant: company-wide XOR assigned to one user.
    isCompanyWide: body.assignedUserId ? false : body.isCompanyWide,
    assignedUserId: body.isCompanyWide && !body.assignedUserId ? null : body.assignedUserId ?? null,
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

// Update — accountant/admin
router.patch('/:id', requireRole('accountant', 'admin'), asyncHandler(async (req, res) => {
  const pm = await db.query.paymentMethods.findFirst({
    where: eq(paymentMethods.id, req.params.id),
  });
  if (!pm) throw notFound('Payment method not found');

  const body = updateSchema.parse(req.body);
  const before = { ...pm };

  // Invariant: a card is either company-wide OR assigned to exactly one user.
  const patch = { ...body };
  if (patch.isCompanyWide === true) patch.assignedUserId = null;
  if (patch.assignedUserId) patch.isCompanyWide = false;

  const [updated] = await db.update(paymentMethods)
    .set({ ...patch, updatedAt: new Date() })
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
