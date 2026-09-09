/**
 * Everything that must be true before a purchase order may be submitted.
 *
 * Submitting a PO is not a request for review — it approves the PO and pushes it
 * to Zoho in the same handler (see routes/transactions.ts). zohoPoPush rejects a
 * PO whose lines lack a Zoho item id, and because there is no PO list UI, a push
 * that fails after the approve leaves a record reachable only by direct URL.
 * So every push precondition is checked here, before the status changes, where
 * the failure is still a correctable form error.
 */

export interface PoSubmitBlocker {
  code: 'MISSING_LINE_ITEMS' | 'MISSING_VENDOR' | 'MISSING_ZOHO_VENDOR' | 'MISSING_ZOHO_ITEM';
  status: 409;
  message: string;
}

export interface PoSubmitInput {
  vendorName: string;
  /** False when the company is configured not to post to Zoho. */
  zohoEnabled: boolean;
  zohoVendorId: string | null;
  lineItems: Array<{ zohoItemId?: string | null }>;
}

export function poSubmitBlocker(input: PoSubmitInput): PoSubmitBlocker | null {
  if (!input.lineItems.length) {
    return {
      code: 'MISSING_LINE_ITEMS',
      status: 409,
      message: 'Add at least one line item before submitting',
    };
  }

  if (!input.vendorName.trim()) {
    return {
      code: 'MISSING_VENDOR',
      status: 409,
      message: 'Add the vendor name before submitting',
    };
  }

  // No push will happen, so the Zoho-shaped requirements do not apply.
  if (!input.zohoEnabled) return null;

  if (!input.zohoVendorId) {
    return {
      code: 'MISSING_ZOHO_VENDOR',
      status: 409,
      message: 'Select a Zoho vendor before submitting this purchase order',
    };
  }

  if (input.lineItems.some((li) => !li.zohoItemId)) {
    return {
      code: 'MISSING_ZOHO_ITEM',
      status: 409,
      message: 'Every line item needs a Zoho item before submitting',
    };
  }

  return null;
}
