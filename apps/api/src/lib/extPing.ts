/**
 * The "you have events" ping. It carries no expense data: the receiving app
 * answers by pulling GET /ext/events. Fire-and-forget; the app's own timer
 * is the safety net, so a lost ping costs a short delay and nothing else.
 */
import crypto from 'node:crypto';
import { env } from '../config/env';
import { logger } from './logger';

const PING_TIMEOUT_MS = 3_000;

/** Hex HMAC-SHA256 of the timestamp string. The receiver recomputes it. */
export function signPing(secret: string, timestamp: string): string {
  return crypto.createHmac('sha256', secret).update(timestamp).digest('hex');
}

/** Ping each URL once. Never throws. */
export async function sendPings(urls: string[]): Promise<void> {
  const secret = env.EXT_EVENTS_PING_SECRET;
  if (!secret || urls.length === 0) return;

  for (const url of urls) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Midas-Timestamp': timestamp,
          'X-Midas-Signature': signPing(secret, timestamp),
        },
        body: '{}',
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!res.ok) logger.warn({ url, status: res.status }, 'Ext events ping was not accepted');
    } catch (err) {
      logger.warn({ err, url }, 'Ext events ping failed');
    }
  }
}
