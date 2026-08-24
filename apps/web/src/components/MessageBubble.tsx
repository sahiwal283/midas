import type { ExpenseMessage, MessageRequestType } from '../types';

/**
 * One message in an expense conversation. Shared by the employee's
 * ExpenseDetail and the accountant's review page — they previously kept
 * near-identical copies, and the accountant's had drifted into labelling every
 * request "Info Requested" regardless of type.
 */

const REQUEST_TYPE_LABELS: Partial<Record<MessageRequestType, string>> = {
  missing_receipt: 'Please upload receipt',
  missing_category: 'Please select category',
  missing_payment_method: 'Please specify payment method',
  info_request: 'Info Requested',
  general: 'Question',
};

export function MessageBubble({
  message,
  currentUserId,
  isPrivileged = false,
}: {
  message: ExpenseMessage;
  currentUserId?: string;
  /** Internal notes are accountant-only; the API also strips them server-side. */
  isPrivileged?: boolean;
}) {
  if (message.isSystem) {
    return (
      <div className="rounded-lg border border-ink/10 bg-cream px-3 py-2 text-center text-xs text-muted break-words">
        {message.body}
      </div>
    );
  }

  if (message.requestType) {
    const resolved = message.isResolved;
    const typeLabel = REQUEST_TYPE_LABELS[message.requestType as MessageRequestType] ?? 'Info Requested';
    return (
      <div className={`rounded-lg border px-3 py-2.5 text-sm ${resolved ? 'border-success/30 bg-success/10' : 'border-amber-300 bg-amber-50'}`}>
        <div className="mb-1.5 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${resolved ? 'bg-success/15 text-success' : 'bg-amber-200 text-amber-800'}`}>
              {resolved ? 'Resolved' : typeLabel}
            </span>
            <span className="font-medium text-charcoal/80">{message.sender?.name ?? 'Accountant'}</span>
          </div>
          <span className="text-xs text-charcoal/40">{new Date(message.createdAt).toLocaleString()}</span>
        </div>
        <p className={`break-words ${resolved ? 'text-success' : 'text-amber-900'}`}>{message.body}</p>
        {isPrivileged && message.internalNote && (
          <p className="mt-2 rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-xs text-yellow-800 break-words">
            <span className="font-semibold">Internal note: </span>{message.internalNote}
          </p>
        )}
      </div>
    );
  }

  const isMine = message.senderId === currentUserId;
  return (
    <div className={`rounded-lg p-3 text-sm ${isMine ? 'bg-brand-50 text-brand-900' : 'bg-cream text-ink'}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium">{message.sender?.name ?? '—'}</span>
        {message.sender?.role !== 'user' && (
          <span className="text-xs opacity-50 capitalize">{message.sender?.role}</span>
        )}
        <span className="text-xs opacity-60">{new Date(message.createdAt).toLocaleString()}</span>
      </div>
      <p className="break-words">{message.body}</p>
    </div>
  );
}

/** Server-side cap in apps/api/src/routes/messages.ts. */
export const MESSAGE_MAX_LENGTH = 2000;
