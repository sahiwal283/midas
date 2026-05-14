import { db } from '../db/index';
import { auditLogs } from '../db/schema';

interface AuditEntry {
  entityType: string;
  entityId: string;
  userId?: string;
  action: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export async function auditLog(entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    entityType: entry.entityType,
    entityId: entry.entityId,
    userId: entry.userId ?? null,
    action: entry.action,
    before: entry.before ?? null,
    after: entry.after ?? null,
    metadata: entry.metadata ?? null,
  });
}
