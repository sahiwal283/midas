import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { notifications, users } from '../db/schema';
import { env } from '../config/env';
import { logger } from './logger';
import { sendEmail } from './email';
import { buildNotification, type NotificationType, type NotificationInput } from './notifyMessages';

export interface NotifyInput extends NotificationInput {
  expenseId: string;
}

/**
 * Insert an in-app notification for a user, then attempt email delivery
 * fire-and-forget (emailed_at set on success). Never throws — notification
 * failures must never break the review/reimbursement request that triggered them.
 */
export async function notifyUser(
  userId: string,
  type: NotificationType,
  input: NotifyInput,
): Promise<void> {
  try {
    const { title, body } = buildNotification(type, input);

    const [row] = await db.insert(notifications).values({
      userId,
      type,
      title,
      body,
      expenseId: input.expenseId,
    }).returning({ id: notifications.id });

    // Fire-and-forget email — the caller's response never waits on SMTP.
    void (async () => {
      try {
        const user = await db.query.users.findFirst({
          where: eq(users.id, userId),
          columns: { email: true },
        });
        if (!user?.email) return;

        const webBase = env.MIDAS_WEB_BASE_URL || env.CORS_ORIGIN;
        const text = `${body}\n\n${webBase}/expenses/${input.expenseId}`;
        const sent = await sendEmail(user.email, title, text);
        if (sent) {
          await db.update(notifications)
            .set({ emailedAt: new Date() })
            .where(eq(notifications.id, row.id));
        }
      } catch (err) {
        logger.error({ err, userId, type }, 'Notification email delivery failed');
      }
    })();
  } catch (err) {
    logger.error({ err, userId, type }, 'Failed to create notification');
  }
}
