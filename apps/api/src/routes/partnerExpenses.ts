import { Router } from 'express';
import { db } from '../db/index';
import { partnerExpenses } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { partnerExpenseCreateSchema } from '../lib/partnerExpenses';

const router = Router();
router.use(authenticate);
// Shared partner view: every partner (and developer) sees all rows.
router.use(requireRole('partner'));

function toDto(row: {
  id: string;
  userId: string;
  amount: string;
  itemLocation: string;
  category: 'business' | 'personal';
  createdAt: Date;
  user?: { name: string } | null;
}) {
  return {
    id: row.id,
    userId: row.userId,
    userName: row.user?.name ?? 'Unknown',
    amount: row.amount,
    itemLocation: row.itemLocation,
    category: row.category,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get('/', asyncHandler(async (_req, res) => {
  const rows = await db.query.partnerExpenses.findMany({
    with: { user: { columns: { name: true } } },
    orderBy: (pe, { desc }) => [desc(pe.createdAt)],
  });
  res.json({ partnerExpenses: rows.map(toDto) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = partnerExpenseCreateSchema.parse(req.body);

  const [row] = await db.insert(partnerExpenses).values({
    userId: req.user!.id,
    amount: body.amount.toFixed(2),
    itemLocation: body.itemLocation,
    category: body.category,
  }).returning();

  await auditLog({
    entityType: 'partner_expense',
    entityId: row.id,
    userId: req.user!.id,
    action: 'created',
    after: row,
  });

  res.status(201).json({ partnerExpense: toDto({ ...row, user: { name: req.user!.name } }) });
}));

export default router;
