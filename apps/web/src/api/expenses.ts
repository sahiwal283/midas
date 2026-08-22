import client from './client';
import type { Expense, ExpenseCategory, Receipt, ExpenseMessage, PaymentMethod, AuditLogEntry, ZohoReadinessResult, ClosedPeriod } from '../types';

export interface DuplicateMatch {
  id: string;
  merchant: string;
  amount: string | number;
  date: string;
  status: string;
}

export const expenseApi = {
  list: (params?: Record<string, string>) =>
    client.get<{ expenses: Expense[] }>('/expenses', { params }).then((r) => r.data.expenses),

  get: (id: string) =>
    client.get<{ expense: Expense }>(`/expenses/${id}`).then((r) => r.data.expense),

  create: (data: {
    merchant?: string;
    amount?: number;
    date?: string;
    /** Wizard flow: create an empty draft before OCR fills the fields. */
    draft?: boolean;
    currency?: string;
    categoryId?: string;
    paymentMethodId?: string;
    description?: string;
    referenceNumber?: string | null;
    zohoEntity?: string;
    zohoExpenseAccountId?: string;
    zohoExpenseAccountName?: string;
    expenseKind?: 'business' | 'partner';
  }) =>
    client.post<{ expense: Expense }>('/expenses', data).then((r) => r.data.expense),

  update: (id: string, data: Partial<{
    merchant: string;
    amount: number;
    date: string;
    categoryId: string;
    paymentMethodId: string;
    description: string;
    referenceNumber: string | null;
    zohoEntity: string;
    zohoExpenseAccountId: string;
    zohoExpenseAccountName: string;
    expenseKind: 'business' | 'partner';
  }>) =>
    client.patch<{ expense: Expense }>(`/expenses/${id}`, data).then((r) => r.data.expense),

  /** Rejected → corrected expense: clones into a fresh draft (owner only). */
  clone: (id: string) =>
    client.post<{ expense: Expense }>(`/expenses/${id}/clone`).then((r) => r.data.expense),

  /** Non-blocking duplicate pre-check for the wizard. */
  checkDuplicate: (data: { merchant: string; amount: number; date: string }) =>
    client.post<{ duplicate: DuplicateMatch | null }>('/expenses/check-duplicate', data).then((r) => r.data),

  zohoEntities: () =>
    client.get<{ entities: Array<{ entity: string; brand: string }> }>('/zoho/entities')
      .then((r) => r.data.entities),

  zohoExpenseAccounts: (zohoEntity: string) =>
    client.get<{
      brand: string;
      accounts: Array<{
        accountId: string;
        accountName: string;
        accountCode: string | null;
        accountType: string;
      }>;
    }>('/zoho/expense-accounts', { params: { zohoEntity } }).then((r) => r.data),

  zohoPaidThroughAccounts: (zohoEntity: string) =>
    client.get<{
      brand: string;
      accounts: Array<{
        accountId: string;
        accountName: string;
        accountCode: string | null;
        accountType: string;
      }>;
    }>('/zoho/paid-through-accounts', { params: { zohoEntity } }).then((r) => r.data),

  submit: (id: string) =>
    client.post<{ expense: Expense; autoPushed?: boolean; missing?: string[] }>(`/expenses/${id}/submit`).then((r) => r.data),

  delete: (id: string, force = false) =>
    client.delete(`/expenses/${id}`, { params: force ? { force: 'true' } : undefined }).then((r) => r.data),

  bulkDelete: async (ids: string[], force = false) => {
    const chunkSize = 200;
    const deleted: string[] = [];
    const failed: Array<{ id: string; code: string; message: string }> = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const result = await client.post<{
        deleted: string[];
        failed: Array<{ id: string; code: string; message: string }>;
      }>('/expenses/bulk-delete', { ids: chunk, force }).then((r) => r.data);
      deleted.push(...result.deleted);
      failed.push(...result.failed);
    }
    return { deleted, failed };
  },

  categories: () =>
    client.get<{ categories: ExpenseCategory[] }>('/expenses/categories/list').then((r) => r.data.categories),

  paymentMethods: () =>
    client.get<{ paymentMethods: PaymentMethod[] }>('/payment-methods').then((r) => r.data.paymentMethods),

  uploadReceipt: (expenseId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    // Default path is sync OCR — response includes ocrStatus done/failed.
    return client.post<{ receipt: Receipt; ocrMode?: 'sync' | 'async' }>(`/expenses/${expenseId}/receipts`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 130_000,
    }).then((r) => r.data.receipt);
  },

  deleteReceipt: (expenseId: string, receiptId: string) =>
    client.delete(`/expenses/${expenseId}/receipts/${receiptId}`).then((r) => r.data),

  getMessages: (expenseId: string) =>
    client.get<{ messages: ExpenseMessage[] }>(`/expenses/${expenseId}/messages`).then((r) => r.data.messages),

  postMessage: (expenseId: string, body: string) =>
    client.post<{ message: ExpenseMessage }>(`/expenses/${expenseId}/messages`, { body }).then((r) => r.data.message),

  zohoReadiness: (expenseId: string) =>
    client.get<{ readiness: ZohoReadinessResult }>(`/expenses/${expenseId}/zoho-readiness`).then((r) => r.data.readiness),
};

export interface ScopeCounts {
  counts: Record<string, number>;
  readyForZohoAmount: number;
  reimbursementPendingAmount: number;
  reimbursementEmployees: number;
}

export interface QueueSummary extends ScopeCounts {
  byScope: {
    event: ScopeCounts;
    daily: ScopeCounts;
  };
}

export interface QueuePage {
  expenses: Expense[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface UpcomingEvent {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  venue: string | null;
  startDate: string;
  endDate: string;
  travelStartDate: string | null;
  travelEndDate: string | null;
  /** Travel dates drive this: 'active' | 'upcoming' | 'recent'. */
  phase: 'upcoming' | 'active' | 'recent';
  /** Days until start (upcoming) or since end (recent); 0 when active. */
  days: number;
  spend: number;
  expenseCount: number;
}

export const accountantApi = {
  queue: (params?: Record<string, string>) =>
    client.get<QueuePage>('/accountant/queue', {
      params: params && Object.keys(params).length > 0 ? params : undefined,
    }).then((r) => r.data),

  employees: () =>
    client.get<{ employees: Array<{ id: string; name: string }> }>('/accountant/employees')
      .then((r) => r.data.employees),

  bulkReview: (ids: string[]) =>
    client.post<{
      approved: string[];
      skipped: Array<{ id: string; reason: string }>;
    }>('/accountant/expenses/bulk-review', { ids, action: 'approve' }).then((r) => r.data),

  bulkZohoPush: (ids: string[]) =>
    client.post<{
      pushed: string[];
      failed: Array<{ id: string; code: string; message: string }>;
    }>('/accountant/zoho/bulk-push', { ids }).then((r) => r.data),

  all: (params?: Record<string, string>) =>
    client.get<{ expenses: Expense[] }>('/accountant/expenses', {
      params: params && Object.keys(params).length > 0 ? params : undefined,
    }).then((r) => r.data.expenses),

  review: (id: string, data: {
    action: 'approve' | 'reject' | 'request_info';
    note?: string;
    zohoEntity?: string;
    requestType?: string;
    internalNote?: string;
  }) =>
    client.patch<{ expense: Expense }>(`/accountant/expenses/${id}/review`, data).then((r) => r.data.expense),

  updateReimbursement: (id: string, data: { status: string; note?: string; confirmSynced?: boolean }) =>
    client.patch<{ expense: Expense }>(`/accountant/expenses/${id}/reimbursement`, data).then((r) => r.data.expense),

  updateCategory: (id: string, data: { categoryId: string; confirmSynced?: boolean }) =>
    client.patch<{ expense: Expense }>(`/accountant/expenses/${id}/category`, data).then((r) => r.data.expense),

  setZohoEntity: (id: string, zohoEntity: string) =>
    client.patch<{ expense: Expense }>(`/accountant/expenses/${id}/zoho-entity`, { zohoEntity }).then((r) => r.data.expense),

  updateReferenceNumber: (id: string, referenceNumber: string | null) =>
    client.patch<{ expense: Expense }>(`/accountant/expenses/${id}/reference-number`, { referenceNumber }).then((r) => r.data.expense),

  pushToZoho: (id: string) =>
    client.post(`/accountant/expenses/${id}/zoho-push`).then((r) => r.data),

  resolveRequest: (id: string) =>
    client.post(`/accountant/expenses/${id}/resolve-request`).then((r) => r.data),

  queueSummary: () =>
    client.get<QueueSummary>('/accountant/queue/summary').then((r) => r.data),

  upcomingEvents: () =>
    client.get<{ events: UpcomingEvent[]; available: boolean }>('/accountant/upcoming-events').then((r) => r.data),

  getAuditTrail: (id: string) =>
    client.get<{ entries: AuditLogEntry[] }>(`/accountant/expenses/${id}/audit`).then((r) => r.data.entries),

  closedPeriods: () =>
    client.get<{ closedPeriods: ClosedPeriod[] }>('/accountant/closed-periods').then((r) => r.data.closedPeriods),

  closePeriod: (period: string, note?: string) =>
    client.post<{ closedPeriod: ClosedPeriod }>('/accountant/closed-periods', { period, note }).then((r) => r.data.closedPeriod),

  reopenPeriod: (period: string) =>
    client.delete<{ ok: boolean }>(`/accountant/closed-periods/${period}`).then((r) => r.data),

  zohoServiceHealth: () =>
    client.get<{
      zohoMode: 'mock' | 'service';
      dryRun: boolean;
      liveWritesEnabled: boolean;
      readyForLivePush: boolean;
      brand: string;
      service: { reachable: boolean; ok: boolean; baseUrl?: string | null; serviceVersion?: string | null; detail?: string | null };
      zohoAuth: { ok: boolean; code?: string | null; message?: string | null; requestId?: string | null };
    }>('/zoho/service-health').then((r) => r.data),
};

export const paymentMethodsApi = {
  list: () =>
    client.get<{ paymentMethods: PaymentMethod[] }>('/payment-methods').then((r) => r.data.paymentMethods),

  create: (data: {
    label: string;
    lastFour?: string;
    brand?: string;
    zohoAccountName?: string;
    defaultZohoEntity?: string;
    requiresReimbursement?: boolean;
    isCompanyWide?: boolean;
    assignedUserId?: string;
  }) =>
    client.post<{ paymentMethod: PaymentMethod }>('/payment-methods', data).then((r) => r.data.paymentMethod),

  update: (id: string, data: {
    label?: string;
    lastFour?: string;
    brand?: string;
    zohoAccountName?: string | null;
    defaultZohoEntity?: string | null;
    requiresReimbursement?: boolean;
    isCompanyWide?: boolean;
    assignedUserId?: string | null;
    isActive?: boolean;
  }) =>
    client.patch<{ paymentMethod: PaymentMethod }>(`/payment-methods/${id}`, data).then((r) => r.data.paymentMethod),
};
