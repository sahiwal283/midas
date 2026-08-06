import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, notFound } from '../middleware/error';
import { evaluateZohoReadiness } from '../lib/zohoReadiness';
import { auditLog } from '../lib/audit';

const router = Router();

router.use(authenticate);

// GET /api/v1/expenses/:id/zoho-readiness
// Evaluates whether an expense is ready for Zoho. Accountant/admin only.
// No live Zoho write occurs — this is a read-only dry evaluation.
router.get('/:id/zoho-readiness', requireRole('accountant', 'admin'), asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, req.params.id),
    with: {
      category: { columns: { id: true, name: true, zohoAccountId: true } },
      paymentMethod: { columns: { id: true, label: true, zohoAccountName: true } },
      receipts: { columns: { id: true } },
      messages: { columns: { requestType: true, isResolved: true } },
    },
  });

  if (!expense) throw notFound('Expense not found');

  const result = evaluateZohoReadiness(expense);

  await auditLog({
    entityType: 'expense',
    entityId: expense.id,
    userId: req.user!.id,
    action: 'zoho.readiness_check',
    metadata: { ready: result.ready, missing: result.missing, zohoMode: result.zohoMode },
  });

  res.json({ readiness: result });
}));

export default router;
