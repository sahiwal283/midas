/** Parses /admin/audit query params into a normalized filter object. */

export interface AuditFilters {
  entityType?: string;
  /** Prefix match (ILIKE `${action}%`). */
  action?: string;
  userId?: string;
  entityId?: string;
  from?: string;
  to?: string;
  /** Substring match on action OR entityType. */
  search?: string;
  page: number;
  pageSize: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AUDIT_DEFAULT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 100;

export function parseAuditFilters(q: Record<string, string | undefined>): AuditFilters {
  const f: AuditFilters = { page: 1, pageSize: AUDIT_DEFAULT_PAGE_SIZE };
  if (q.entityType?.trim()) f.entityType = q.entityType.trim();
  if (q.action?.trim()) f.action = q.action.trim();
  if (q.userId && UUID_RE.test(q.userId)) f.userId = q.userId;
  if (q.entityId?.trim()) f.entityId = q.entityId.trim();
  if (q.from && DATE_RE.test(q.from)) f.from = q.from;
  if (q.to && DATE_RE.test(q.to)) f.to = q.to;
  if (q.search?.trim()) f.search = q.search.trim();

  const page = Number(q.page);
  if (Number.isInteger(page) && page >= 1) f.page = page;

  const pageSize = Number(q.pageSize);
  if (Number.isInteger(pageSize) && pageSize >= 1) {
    f.pageSize = Math.min(pageSize, AUDIT_MAX_PAGE_SIZE);
  }
  return f;
}
