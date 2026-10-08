/**
 * Hand-off of submitter-facing notifications to the external app that owns
 * the expense. Pure: no db, no env. The app pulls what is recorded here from
 * GET /ext/events; Midas then sends that person nothing itself.
 */
import type { ExtEventPayload } from '../db/schema';

/** Notification types an external app is told about. needs_review is Midas-only. */
export const HANDOFF_TYPES = [
  'approved', 'rejected', 'action_required', 'message', 'mention',
  'reimbursement_paid', 'expense_incomplete',
] as const;

export interface HandOffDecisionInput {
  type: string;
  recipientId: string;
  ownerId: string;
  sourceApp: string | null;
  externalUserId: string | null;
  /** An active connection for sourceApp has events_enabled. */
  eventsEnabled: boolean;
}

/**
 * Only the expense's own submitter is handed off, and only when the app has
 * told us who that is. Everyone else (staff, a mentioned accountant) is a
 * Midas user and is notified here as usual.
 */
export function shouldHandOff(i: HandOffDecisionInput): boolean {
  return i.eventsEnabled
    && Boolean(i.sourceApp)
    && Boolean(i.externalUserId)
    && i.recipientId === i.ownerId
    && (HANDOFF_TYPES as readonly string[]).includes(i.type);
}

export interface HandOffExpense {
  id: string;
  userId: string;
  sourceApp: string | null;
  sourceRefId: string | null;
  externalUserId: string | null;
  merchant: string;
  amount: string;
  status: string;
}

export interface HandOffDetails {
  senderName?: string;
  excerpt?: string;
  messageId?: string;
  requestType?: string;
  note?: string;
  missing?: string[];
}

/** Everything the app needs to word its own notification, so it never calls back. */
export function buildExtEventPayload(expense: HandOffExpense, input: HandOffDetails): ExtEventPayload {
  return {
    externalUserId: expense.externalUserId ?? '',
    expense: {
      id: expense.id,
      sourceRefId: expense.sourceRefId,
      merchant: expense.merchant,
      amount: String(expense.amount),
      status: expense.status,
    },
    ...(input.senderName ? { senderName: input.senderName } : {}),
    ...(input.excerpt ? { excerpt: input.excerpt } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.requestType ? { requestType: input.requestType } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.missing && input.missing.length > 0 ? { missing: input.missing } : {}),
  };
}

/** The `since` cursor: the last seq the caller processed. Null means invalid. */
export function parseSince(raw: unknown): number | null {
  if (raw === undefined || raw === '') return 0;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export function clampLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export interface FeedEvent extends ExtEventPayload {
  seq: number;
  id: string;
  type: string;
  createdAt: string;
}

export interface ExtEventRow {
  seq: number;
  id: string;
  type: string;
  createdAt: Date;
  payload: ExtEventPayload;
}

/** The wire shape of one event: envelope fields first, then the payload, flat. */
export function toFeedEvent(row: ExtEventRow): FeedEvent {
  return {
    seq: Number(row.seq),
    id: row.id,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
    ...row.payload,
  };
}
