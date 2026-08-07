/** State-based edit rules. Zoho-synced expenses are NEVER silently editable. */

export type Editability = 'all' | 'notes_only' | 'none';

export function editableFields(status: string, zohoExpenseId: string | null): Editability {
  if (zohoExpenseId) return 'none';
  if (status === 'draft' || status === 'awaiting_info') return 'all';
  if (status === 'pending') return 'notes_only';
  return 'none';
}

export function editRefusalMessage(status: string, zohoExpenseId: string | null): string {
  if (zohoExpenseId) return 'This expense is synced to Zoho and cannot be edited. Corrections require an explicit adjustment.';
  if (status === 'pending') return 'Only notes can be changed while the expense is awaiting approval.';
  return `Expenses cannot be edited from status '${status}'.`;
}
