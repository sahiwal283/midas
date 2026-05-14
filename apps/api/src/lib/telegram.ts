import { env } from '../config/env';
import { logger } from './logger';

// Midas does NOT own the conversation — it only sends notifications to Telegram.
// The canonical conversation/audit trail lives in expense_messages.
export async function notifyTelegram(chatId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, 'Telegram notification failed');
    }
  } catch (err) {
    logger.warn({ err }, 'Telegram notification error');
  }
}
