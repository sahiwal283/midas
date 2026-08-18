import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { notifications, pushSubscriptions } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound } from '../middleware/error';
import { pushConfigured } from '../lib/push';
import { env } from '../config/env';

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

// ── Web push subscriptions ────────────────────────────────────────────────────

// Public VAPID key for the client's PushManager.subscribe(). `null` means push
// is not configured in this environment and the UI should hide the option.
router.get('/push/public-key', asyncHandler(async (_req, res) => {
  res.json({ publicKey: pushConfigured() ? env.VAPID_PUBLIC_KEY : null });
}));

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

router.post('/push/subscribe', asyncHandler(async (req, res) => {
  const { endpoint, keys } = subscribeSchema.parse(req.body);

  // Endpoint identifies the browser/device. If another account previously
  // registered this device, reassign it to the current user.
  const [sub] = await db.insert(pushSubscriptions)
    .values({
      userId: req.user!.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: req.get('user-agent') ?? null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: req.user!.id,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: req.get('user-agent') ?? null,
      },
    })
    .returning({ id: pushSubscriptions.id });

  res.status(201).json({ id: sub.id });
}));

const unsubscribeSchema = z.object({ endpoint: z.string().url() });

router.post('/push/unsubscribe', asyncHandler(async (req, res) => {
  const { endpoint } = unsubscribeSchema.parse(req.body);

  await db.delete(pushSubscriptions).where(and(
    eq(pushSubscriptions.endpoint, endpoint),
    eq(pushSubscriptions.userId, req.user!.id),
  ));

  res.json({ ok: true });
}));

export default router;
