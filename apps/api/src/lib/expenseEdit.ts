/** State-based edit rules. Zoho-synced expenses are NEVER silently editable. */

export type Editability = 'all' | 'notes_only' | 'none';

export function editableFields(status: string, zohoExpenseId: string | null): Editability {
  if (zohoExpenseId) return 'none';
  // pending stays fully editable so submitters can complete missing fields
  // (receipt, payment method, …) before an accountant picks the expense up —
  // a completed daily expense then auto-approves (see lib/pendingCompletion).
  if (status === 'draft' || status === 'awaiting_info' || status === 'pending') return 'all';
  return 'none';
}

export function editRefusalMessage(status: string, zohoExpenseId: string | null): string {
  if (zohoExpenseId) return 'This expense is synced to Zoho and cannot be edited. Corrections require an explicit adjustment.';
  return `Expenses cannot be edited from status '${status}'.`;
}
