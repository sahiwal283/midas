import client from './client';

export interface CashBusiness {
  id: string;
  name: string;
  payrollLinked: boolean;
  available: boolean;
  onHandCents: number;
  depositsCents: number;
  withdrawalsCents: number;
  entryCount: number;
}

export interface CashLedgerEntry {
  id: string;
  kind: 'DEPOSIT' | 'WITHDRAWAL';
  amountCents: number;
  invoiceNumber: string | null;
  notes: string | null;
  category: string | null;
  /** true when a receipt file exists (local drawers only). */
  receiptPath: boolean | string | null;
  periodLinked: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  /** YYYY-MM-DD; null for payroll-linked rows (they cannot be backdated). */
  entryDate: string | null;
  createdByLabel: string | null;
  createdAt: string;
}

export const cashbookApi = {
  businesses: () =>
    client.get<{ businesses: CashBusiness[]; payrollAppUrl: string | null }>('/cashbook/businesses').then((r) => r.data),

  createBusiness: (name: string) =>
    client.post<{ business: CashBusiness }>('/cashbook/businesses', { name }).then((r) => r.data.business),

  ledger: (businessId: string) =>
    client.get<{ entries: CashLedgerEntry[]; payrollLinked: boolean; payrollAppUrl: string | null }>(`/cashbook/businesses/${businessId}/ledger`).then((r) => r.data),

  deposit: (businessId: string, body: { amount: string; invoiceNumber: string; notes?: string; entryDate?: string }) =>
    client.post(`/cashbook/businesses/${businessId}/deposit`, body),

  withdrawal: (businessId: string, body: { amount: string; notes?: string; entryDate?: string }) =>
    client.post(`/cashbook/businesses/${businessId}/withdrawal`, body),

  pettyCash: (businessId: string, form: FormData) =>
    client.post(`/cashbook/businesses/${businessId}/petty-cash`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),

  voidEntry: (businessId: string, entryId: string) =>
    client.post(`/cashbook/businesses/${businessId}/entries/${entryId}/void`),

  exportCsvUrl: (businessId: string) => `/api/v1/cashbook/businesses/${businessId}/export.csv`,
  receiptUrl: (businessId: string, entryId: string) => `/api/v1/cashbook/businesses/${businessId}/entries/${entryId}/receipt`,
};
