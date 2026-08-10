import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

// Lazy singleton — only built on first send when EMAIL_MODE=smtp.
let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ? Number(env.SMTP_PORT) : 587,
      // Port 465 is implicit TLS; everything else negotiates STARTTLS.
      secure: env.SMTP_PORT === '465',
      auth: env.SMTP_USER
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : undefined,
    });
  }
  return transporter;
}

/**
 * Best-effort email delivery. Never throws.
 * Returns true only when the message was handed to the SMTP server.
 * EMAIL_MODE=off (default) logs the would-be send and returns false.
 */
export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (env.EMAIL_MODE === 'off') {
    console.log('[email:off]', { to, subject, text });
    return false;
  }
  try {
    await getTransporter().sendMail({
      from: env.SMTP_FROM ?? env.SMTP_USER,
      to,
      subject,
      text,
    });
    return true;
  } catch (err) {
    logger.error({ err, to, subject }, 'Email send failed');
    return false;
  }
}
