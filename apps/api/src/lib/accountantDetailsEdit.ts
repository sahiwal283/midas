/**
 * Accountant field corrections on someone else's expense.
 *
 * Accountants can already fix category, company, reference number and
 * reimbursement from the review page. The remaining Zoho-push blockers they
 * could see but not fix were payment method, merchant, amount and date — this
 * planner is the shared guard for that patch.
 *
 * Pure: no db, no env. The route supplies the closed-period list.
 */

import { isInClosedPeriods, periodOf, closedPeriodMessage } from './closedPeriods';
import { editRefusalMessage } from './expenseEdit';

/** The expense fields this patch reads. `amount` is the numeric column's string. */
export interface DetailsEditTarget {
  merchant: string | null;
  amount: string | null;
  date: string;
  paymentMethodId: string | null;
  zohoExpenseId: string | null;
}

/** Any subset — omitted keys are left alone. */
export interface DetailsEditPatch {
  merchant?: string;
  amount?: number;
  date?: string;
  paymentMethodId?: string;
}

/** Column values to write. `amount` is stringified for the numeric column. */
export interface DetailsEditChanges {
  merchant?: string;
  amount?: string;
  date?: string;
  paymentMethodId?: string;
}

export interface DetailsEditRefusal {
  code: 'NOT_EDITABLE' | 'PERIOD_CLOSED';
  message: string;
  status: number;
}

export type DetailsEditPlan =
  | { ok: true; changes: DetailsEditChanges }
  | { ok: false; refusal: DetailsEditRefusal };

export function planAccountantDetailsEdit(
  expense: DetailsEditTarget,
  patch: DetailsEditPatch,
  closedPeriods: string[],
): DetailsEditPlan {
  // Zoho holds the record once pushed — corrections there need an explicit
  // adjustment, never a silent Midas-side rewrite.
  if (expense.zohoExpenseId) {
    return {
      ok: false,
      refusal: {
        code: 'NOT_EDITABLE',
        message: editRefusalMessage('', expense.zohoExpenseId),
        status: 409,
      },
    };
  }

  // Both the month it sits in and the month it would move to must be open,
  // otherwise a date edit could smuggle an expense into closed books.
  const blocked = [expense.date, patch.date].find(
    (d): d is string => !!d && isInClosedPeriods(d, closedPeriods),
  );
  if (blocked) {
    return {
      ok: false,
      refusal: {
        code: 'PERIOD_CLOSED',
        message: closedPeriodMessage(periodOf(blocked)),
        status: 409,
      },
    };
  }

  const changes: DetailsEditChanges = {};

  if (patch.merchant !== undefined) {
    const merchant = patch.merchant.trim();
    if (merchant !== (expense.merchant ?? '').trim()) changes.merchant = merchant;
  }
  if (patch.amount !== undefined) {
    // Stored as a numeric string ('948.00'), so compare as numbers.
    if (patch.amount !== Number(expense.amount)) changes.amount = patch.amount.toFixed(2);
  }
  if (patch.date !== undefined && patch.date !== expense.date) {
    changes.date = patch.date;
  }
  if (patch.paymentMethodId !== undefined && patch.paymentMethodId !== expense.paymentMethodId) {
    changes.paymentMethodId = patch.paymentMethodId;
  }

  return { ok: true, changes };
}
