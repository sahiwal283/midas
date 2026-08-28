import { env } from '../config/env';

/**
 * Deep link back to a record in the Midas web app, for notes written into
 * external systems. Falls back to CORS_ORIGIN when MIDAS_WEB_BASE_URL is unset,
 * matching lib/notify, lib/ext/dto and routes/admin. Returns null only when
 * neither is set, so callers emit the bare record id rather than a broken link.
 */
export function midasRecordUrl(path: 'expenses' | 'purchase-orders', id: string): string | null {
  const base = (env.MIDAS_WEB_BASE_URL || env.CORS_ORIGIN)?.trim().replace(/\/+$/, '');
  return base ? `${base}/${path}/${id}` : null;
}
