import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { notifications, users } from '../db/schema';
import { env } from '../config/env';
import { logger } from './logger';
import { sendEmail } from './email';
import { sendPushToUser } from './push';
import { buildNotification, type NotificationType, type NotificationInput } from './notifyMessages';
import { notificationPath } from './notificationLinks';
import { shouldHandOff, buildExtEventPayload } from './extEvents';
import { loadHandOffContext, recordExtEvent } from './extEventsDb';
import { sendPings } from './extPing';

export interface NotifyInput extends NotificationInput {
  expenseId: string;
  /**
   * The expense's submitter. Defaults to the recipient, which is right for
   * every notification except a reply travelling to the accountant side.
   */
  ownerId?: string;
}

export interface NotifyOptions {
  /**
   * Whether to also send email. Defaults to true. Conversation messages opt
   * out — a ten-reply thread would otherwise be ten emails, while approvals
   * and reimbursements stay worth an inbox interruption.
   */
  email?: boolean;
}

/**
 * Hand the notification to the external app that owns the expense, when it
 * is addressed to that app's own user (see lib/extEvents). True means the
 * event was recorded and Midas must deliver nothing itself. A failed
 * pre-check falls back to delivering in Midas (nothing was recorded).
 */
async function handOffToSourceApp(userId: string, type: NotificationType, input: NotifyInput): Promise<boolean> {
  let ctx: Awaited<ReturnType<typeof loadHandOffContext>>;
  try {
    ctx = await loadHandOffContext(input.expenseId);
  } catch (err) {
    logger.error({ err, expenseId: input.expenseId, type }, 'Hand-off pre-check failed; delivering in Midas');
    return false;
  }
  if (!ctx) return false;
  if (!shouldHandOff({
    type,
    recipientId: userId,
    ownerId: ctx.expense.userId,
    sourceApp: ctx.expense.sourceApp,
    externalUserId: ctx.expense.externalUserId,
    eventsEnabled: ctx.eventsEnabled,
  })) return false;

  await recordExtEvent({
    sourceApp: ctx.expense.sourceApp!,
    type,
    expenseId: ctx.expense.id,
    payload: buildExtEventPayload(ctx.expense, input),
  });
  // After the row is durable: tell the app to pull. Fire-and-forget.
  void sendPings(ctx.pingUrls);
  return true;
}

/**
 * Insert an in-app notification for a user, then attempt email delivery
 * fire-and-forget (emailed_at set on success). Never throws — notification
 * failures must never break the review/reimbursement request that triggered them.
 * For the submitter of an expense whose source app has events enabled, the
 * notification is handed to that app instead (see handOffToSourceApp) and
 * nothing is delivered here.
 */
export async function notifyUser(
  userId: string,
  type: NotificationType,
  input: NotifyInput,
  opts: NotifyOptions = {},
): Promise<void> {
  try {
    if (await handOffToSourceApp(userId, type, input)) return;

    const { title, body } = buildNotification(type, input);

    const recipient = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true, role: true },
    });
    if (!recipient) return;

    const [row] = await db.insert(notifications).values({
      userId,
      type,
      title,
      body,
      expenseId: input.expenseId,
    }).returning({ id: notifications.id });

    // Fire-and-forget web push — sendPushToUser never throws and is a no-op
    // unless VAPID keys are configured.
    void sendPushToUser(userId, {
      title,
      body,
      url: notificationPath({
        type,
        expenseId: input.expenseId,
        ownerId: input.ownerId ?? userId,
        recipientId: userId,
        recipientRole: recipient.role,
      }),
      tag: `expense-${input.expenseId}`,
      notificationId: row.id,
    });

    if (opts.email === false) return;

    // Fire-and-forget email — the caller's response never waits on SMTP.
    void (async () => {
      try {
        if (!recipient.email) return;

        const webBase = env.MIDAS_WEB_BASE_URL || env.CORS_ORIGIN;
        const text = `${body}\n\n${webBase}/expenses/${input.expenseId}`;
        const sent = await sendEmail(recipient.email, title, text);
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
