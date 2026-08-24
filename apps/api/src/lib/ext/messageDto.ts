/**
 * Ext wire shapes for expense messages.
 *
 * internalNote is absent by construction — it is never selected into these
 * objects, so it cannot leak through a later refactor of the query.
 */

type MessageRow = {
  id: string;
  body: string;
  isSystem: boolean;
  requestType: string | null;
  isResolved: boolean;
  resolvedAt: Date | null;
  createdAt: Date;
  sender?: { id: string; name: string; role: string; email: string | null } | null;
};

export function toExtMessageDto(row: MessageRow) {
  return {
    id: row.id,
    body: row.body,
    sender: {
      id: row.sender?.id ?? null,
      name: row.sender?.name ?? 'Unknown',
      role: row.sender?.role ?? null,
      // Consumers key their own users by email (submitterEmail is how they
      // create expenses here), and a Midas user id means nothing to them.
      // Without this a consumer cannot tell which messages are its user's own.
      email: row.sender?.email ?? null,
    },
    isSystem: row.isSystem,
    requestType: row.requestType,
    isResolved: row.isResolved,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
