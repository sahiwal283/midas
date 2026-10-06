/**
 * Accountant field corrections on someone else's expense.
 *
 * Accountants can already fix reference number and reimbursement from their
 * own controls. The Zoho-push blockers they could see but not fix were payment
 * method, merchant, amount, date and — until the company field was added here
 * — the company itself, which no control on the page could set once the
 * expense left the owner's editable statuses. Notes and category ride in the
 * same patch, with looser rules: see the label-only branch below. This planner
 * is the shared guard for that patch.
 *
 * Pure: no db, no env. The route supplies the closed-period list.
 */

import { isInClosedPeriods, periodOf, closedPeriodMessage } from './closedPeriods';
import { editRefusalMessage } from './expenseEdit';
import { eventChangeFor, eventOwnershipRefusal } from './eventSelection';

/** The expense fields this patch reads. `amount` is the numeric column's string. */
export interface DetailsEditTarget {
  /** Company the expense is charged to — the Zoho org it will be filed in. */
  zohoEntity: string | null;
  merchant: string | null;
  amount: string | null;
  date: string;
  paymentMethodId: string | null;
  categoryId: string | null;
  /** The expense's notes, shown as "Notes" in the UI. */
  description: string | null;
  zohoExpenseId: string | null;
  /** Which app created this row — read alongside sourceRefId for the refusal message. */
  sourceApp: string | null;
  /** Non-null means an external app created this row and owns its source identity. */
  sourceRefId: string | null;
  sourceContext: Record<string, unknown> | null;
}

/** Any subset — omitted keys are left alone. */
export interface DetailsEditPatch {
  /** Company name, already validated against the active catalog by the route. */
  zohoEntity?: string;
  merchant?: string;
  amount?: number;
  date?: string;
  paymentMethodId?: string;
  /** Category id, already validated as active by the route. */
  categoryId?: string;
  /** Notes text; an empty (or whitespace-only) string clears the note. */
  description?: string;
  /** Attach an event, or null to clear it. Absent leaves it alone. */
  event?: { id: string; name: string } | null;
  /**
   * The accountant has seen that the expense is already in Zoho Books and
   * accepts that the change lands in Midas only. Read only for a notes and/or
   * category edit on a pushed expense; ignored otherwise.
   */
  confirmSynced?: boolean;
}

/** Column values to write. `amount` is stringified for the numeric column. */
export interface DetailsEditChanges {
  zohoEntity?: string;
  merchant?: string;
  amount?: string;
  date?: string;
  paymentMethodId?: string;
  categoryId?: string;
  description?: string | null;
  sourceApp?: string | null;
  sourceType?: string | null;
  sourceLabel?: string | null;
  sourceContext?: Record<string, unknown>;
}

export interface DetailsEditRefusal {
  code: 'NOT_EDITABLE' | 'PERIOD_CLOSED' | 'EVENT_NOT_EDITABLE' | 'CONFIRM_SYNCED';
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
  // Notes and category are labels: they decide how a report reads and are
  // never written back to Zoho, so they stay correctable where the financial
  // fields are frozen — after the push, and in a closed month.
  const labelOnly = isLabelOnlyPatch(patch);

  // Zoho holds the record once pushed — corrections there need an explicit
  // adjustment, never a silent Midas-side rewrite. A patch that touches
  // anything else alongside the labels is refused whole.
  if (expense.zohoExpenseId && !labelOnly) {
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
  const blocked = labelOnly ? undefined : [expense.date, patch.date].find(
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

  if (patch.event !== undefined) {
    const refusal = eventOwnershipRefusal(expense.sourceApp, expense.sourceRefId);
    if (refusal) return { ok: false, refusal };
  }

  const changes: DetailsEditChanges = {};

  if (patch.categoryId !== undefined && patch.categoryId !== expense.categoryId) {
    changes.categoryId = patch.categoryId;
  }
  if (patch.description !== undefined) {
    const description = patch.description.trim() || null;
    if (description !== (expense.description?.trim() || null)) changes.description = description;
  }

  if (expense.zohoExpenseId) {
    const changed = [
      ...('description' in changes ? ['notes'] : []),
      ...('categoryId' in changes ? ['category'] : []),
    ];
    if (changed.length > 0 && !patch.confirmSynced) {
      return {
        ok: false,
        refusal: {
          code: 'CONFIRM_SYNCED',
          message: `This expense is already in Zoho Books. Confirm to change the ${changed.join(' and ')} in Midas only — Zoho is not changed.`,
          status: 409,
        },
      };
    }
    return { ok: true, changes };
  }

  // An approved expense with no company cannot be pushed, and the company is
  // also what decides which Zoho org — and so which chart of accounts — the
  // expense belongs to. The route re-resolves the stored account id whenever
  // this changes; see accountColumnsForCompanyChange.
  if (patch.zohoEntity !== undefined && patch.zohoEntity !== expense.zohoEntity) {
    changes.zohoEntity = patch.zohoEntity;
  }
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
  if (patch.event !== undefined) {
    // Shared with the owner's own PATCH path, so a no-op event edit writes
    // nothing on either — clearing an event a row never had would wipe the
    // source columns another app wrote there.
    const change = eventChangeFor(expense, patch.event);
    if (change) Object.assign(changes, change);
  }

  return { ok: true, changes };
}

/** True when the patch carries nothing but notes and/or category (and the confirmation flag). */
function isLabelOnlyPatch(patch: DetailsEditPatch): boolean {
  return (patch.description !== undefined || patch.categoryId !== undefined)
    && Object.entries(patch).every(
      ([k, v]) => k === 'description' || k === 'categoryId' || k === 'confirmSynced' || v === undefined,
    );
}
