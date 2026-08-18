import webpush from 'web-push';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index';
import { pushSubscriptions } from '../db/schema';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Web Push (VAPID) delivery. Disabled unless both VAPID keys are configured —
 * every function here is a safe no-op in that case, mirroring EMAIL_MODE=off.
 */

let configured = false;

export function pushConfigured(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function ensureConfigured(): boolean {
  if (!pushConfigured()) return false;
  if (!configured) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
    configured = true;
  }
  return true;
}

export interface PushPayload {
  title: string;
  body?: string | null;
  /** Path the notification opens, e.g. `/expenses/<id>`. */
  url?: string;
  /** Collapse key — later pushes with the same tag replace earlier ones. */
  tag?: string;
}

/**
 * Send a push to every registered device of a user. Never throws; dead
 * endpoints (404/410 from the push service) are pruned as they are found.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return;

  try {
    const subs = await db.query.pushSubscriptions.findMany({
      where: eq(pushSubscriptions.userId, userId),
    });
    if (subs.length === 0) return;

    const body = JSON.stringify(payload);
    const delivered: string[] = [];

    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
        delivered.push(sub.id);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Subscription expired or unsubscribed at the push service — prune it.
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
        } else {
          logger.error({ err, userId, endpoint: sub.endpoint }, 'Push delivery failed');
        }
      }
    }));

    if (delivered.length > 0) {
      await db.update(pushSubscriptions)
        .set({ lastUsedAt: new Date() })
        .where(inArray(pushSubscriptions.id, delivered));
    }
  } catch (err) {
    logger.error({ err, userId }, 'Push fan-out failed');
  }
}
