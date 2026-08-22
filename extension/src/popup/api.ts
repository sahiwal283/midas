// Popup-side API client for the quick-expense pipeline.
// Talks to the standard session-cookie Midas API (the same endpoints the web
// wizard uses). CORS on the API already allows chrome-extension:// origins;
// credentialed fetch sends the httpOnly session cookie automatically.
import type {
  PaymentMethodOption,
  CompanyOption,
  ExpenseAccountOption,
  OcrFields,
} from '../shared/types';
import { getConfig } from '../shared/config';

export class ApiError extends Error {
  isAuth: boolean;
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.isAuth = status === 401;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { midasApiUrl } = await getConfig();
  const res = await fetch(`${midasApiUrl}/api/v1${path}`, {
    credentials: 'include',
    ...init,
  });

  if (!res.ok) {
    let message = `Midas API error (${res.status})`;
    if (res.status === 401) message = 'You must be logged in to Midas.';
    try {
      const data = (await res.json()) as { error?: { message?: string } };
      if (data?.error?.message) message = data.error.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiError(message, res.status);
  }

  return res.json() as Promise<T>;
}

export interface ExpenseResponse {
  id: string;
  status: string;
}

export interface ReceiptResponse {
  id: string;
  ocrStatus: string;
  ocrData?: { fields?: OcrFields } | null;
}

export const api = {
  /** Step 1 — empty draft (the wizard pipeline's anchor). */
  createDraft(): Promise<ExpenseResponse> {
    return apiFetch<{ expense: ExpenseResponse }>('/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: true }),
    }).then((r) => r.expense);
  },

  /**
   * Step 2 — upload the receipt; sync OCR fills ocrData when it succeeds.
   * The filename must match the real type: Midas keys its PDF viewer off the
   * extension, so a PDF sent as "receipt.png" renders as a broken image.
   */
  async uploadReceipt(
    expenseId: string,
    imageDataUrl: string,
    fileName?: string,
  ): Promise<ReceiptResponse> {
    const blob = await (await fetch(imageDataUrl)).blob();
    const name = fileName?.trim()
      || (blob.type === 'application/pdf' ? 'receipt.pdf' : 'receipt.png');
    const form = new FormData();
    form.append('file', blob, name);
    return apiFetch<{ receipt: ReceiptResponse }>(`/expenses/${expenseId}/receipts`, {
      method: 'POST',
      body: form,
    }).then((r) => r.receipt);
  },

  paymentMethods(): Promise<PaymentMethodOption[]> {
    return apiFetch<{ paymentMethods: PaymentMethodOption[] }>('/payment-methods').then((r) => r.paymentMethods);
  },

  companies(): Promise<CompanyOption[]> {
    return apiFetch<{ companies: CompanyOption[] }>('/companies').then((r) => r.companies);
  },

  expenseAccounts(zohoEntity: string): Promise<ExpenseAccountOption[]> {
    return apiFetch<{ accounts: ExpenseAccountOption[] }>(
      `/zoho/expense-accounts?zohoEntity=${encodeURIComponent(zohoEntity)}`,
    ).then((r) => r.accounts);
  },

  /** Step 3 — final field values before submit. */
  updateExpense(
    expenseId: string,
    payload: {
      merchant: string;
      amount: number;
      date: string;
      paymentMethodId?: string;
      zohoEntity?: string;
      zohoExpenseAccountId?: string;
      zohoExpenseAccountName?: string;
      description?: string;
      referenceNumber?: string;
    },
  ): Promise<ExpenseResponse> {
    return apiFetch<{ expense: ExpenseResponse }>(`/expenses/${expenseId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.expense);
  },

  /** Step 4 — submit; the SERVER decides pending vs auto-approve + Zoho push. */
  submitExpense(expenseId: string): Promise<{ expense: ExpenseResponse; autoPushed?: boolean }> {
    return apiFetch<{ expense: ExpenseResponse; autoPushed?: boolean }>(`/expenses/${expenseId}/submit`, {
      method: 'POST',
    });
  },
};
