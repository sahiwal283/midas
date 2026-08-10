import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { notifications } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound } from '../middleware/error';

const router = Router();
router.use(authenticate);

const listQuerySchema = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

// ── List own notifications (+ unread count) ───────────────────────────────────

router.get('/', asyncHandler(async (req, res) => {
  const { unread, limit } = listQuerySchema.parse(req.query);

  const conds = [eq(notifications.userId, req.user!.id)];
  if (unread === 'true') conds.push(isNull(notifications.readAt));

  const rows = await db.query.notifications.findMany({
    where: and(...conds),
    orderBy: [desc(notifications.createdAt)],
    limit,
  });

  const [{ unreadCount }] = await db
    .select({ unreadCount: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt)));

  res.json({ notifications: rows, unreadCount });
}));

// ── Mark one read (own only) ──────────────────────────────────────────────────

router.post('/:id/read', asyncHandler(async (req, res) => {
  const [updated] = await db.update(notifications)
    .set({ readAt: new Date() })
    .where(and(
      eq(notifications.id, req.params.id),
      eq(notifications.userId, req.user!.id),
    ))
    .returning();
  if (!updated) throw notFound('Notification not found');

  res.json({ notification: updated });
}));

// ── Mark all read ─────────────────────────────────────────────────────────────

router.post('/read-all', asyncHandler(async (req, res) => {
  await db.update(notifications)
    .set({ readAt: new Date() })
    .where(and(
      eq(notifications.userId, req.user!.id),
      isNull(notifications.readAt),
    ));

  res.json({ ok: true });
}));

export default router;
