import { MAX_WAIVER_REASON } from '@midas/shared';

/**
 * Whether an expense may be pushed to Zoho given its receipt situation.
 *
 * A receipt is required. An accountant may push without one by writing a
 * justification, which is stored on the expense and carried into the Zoho note.
 * That is the only waivable check — every other push precondition is a
 * technical prerequisite (no account id, no paid-through id, no entity) where
 * waiving would not produce a valid payload anyway.
 *
 * Pure by design: `zohoPush` imports the database, so the decision lives here
 * where the DB-free API test suite can reach it. Same reason as
 * lib/poSubmitGate and lib/expenseDelete.
 */

export interface ReceiptPushInput {
  hasReceipt: boolean;
  /** Already on the row from an earlier waiver — this is what makes a retry work. */
  storedWaiverReason: string | null;
  /** Supplied by an accountant on this call. */
  suppliedReason?: string;
}

export interface ReceiptPushBlocker {
  code: 'MISSING_RECEIPT' | 'INVALID_WAIVER_REASON';
  status: 409 | 400;
  message: string;
}

/** Trimmed reason, or null when there is nothing usable. */
export function normalizeWaiverReason(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

export function receiptPushBlocker(input: ReceiptPushInput): ReceiptPushBlocker | null {
  // A receipt settles it. Checked first so a malformed reason cannot block a
  // push that never needed a waiver.
  if (input.hasReceipt) return null;

  const supplied = normalizeWaiverReason(input.suppliedReason);

  // Distinguish "sent a reason we cannot use" from "sent no reason": the first
  // is a client bug worth a 400, the second is the ordinary blocked state.
  if (input.suppliedReason !== undefined && !supplied) {
    return {
      code: 'INVALID_WAIVER_REASON',
      status: 400,
      message: 'Write a reason for pushing without a receipt.',
    };
  }

  if (supplied && supplied.length > MAX_WAIVER_REASON) {
    return {
      code: 'INVALID_WAIVER_REASON',
      status: 400,
      message: `Keep the reason to ${MAX_WAIVER_REASON} characters or fewer.`,
    };
  }

  if (supplied) return null;
  if (normalizeWaiverReason(input.storedWaiverReason)) return null;

  return {
    code: 'MISSING_RECEIPT',
    status: 409,
    message: 'This expense has no receipt. Push it with a written reason, or ask the submitter to attach one.',
  };
}
