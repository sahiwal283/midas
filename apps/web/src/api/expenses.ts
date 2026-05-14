import client from './client';
import type { Expense, ExpenseCategory, Receipt, ExpenseMessage, PaymentMethod, AuditLogEntry } from '../types';

export const expenseApi = {
  list: (params?: Record<string, string>) =>
    client.get<{ expenses: Expense[] }>('/expenses', { params }).then((r) => r.data.expenses),

  get: (id: string) =>
    client.get<{ expense: Expense }>(`/expenses/${id}`).then((r) => r.data.expense),

  create: (data: {
    merchant: string;
    amount: number;
    date: string;
    currency?: string;
    categoryId?: string;
    paymentMethodId?: string;
    description?: string;
  }) =>
    client.post<{ expense: Expense }>('/expenses', data).then((r) => r.data.expense),

  update: (id: string, data: Partial<{
    merchant: string;
    amount: number;
    date: string;
    categoryId: string;
    paymentMethodId: string;
    description: string;
  }>) =>
    client.patch<{ expense: Expense }>(`/expenses/${id}`, data).then((r) => r.data.expense),

  submit: (id: string) =>
    client.post<{ expense: Expense }>(`/expenses/${id}/submit`).then((r) => r.data.expense),

  delete: (id: string) =>
    client.delete(`/expenses/${id}`).then((r) => r.data),

  categories: () =>
    client.get<{ categories: ExpenseCategory[] }>('/expenses/categories/list').then((r) => r.data.categories),

  paymentMethods: () =>
    client.get<{ paymentMethods: PaymentMethod[] }>('/payment-methods').then((r) => r.data.paymentMethods),

  uploadReceipt: (expenseId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return client.post<{ receipt: Receipt }>(`/expenses/${expenseId}/receipts`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data.receipt);
  },

  deleteReceipt: (expenseId: string, receiptId: string) =>
    client.delete(`/expenses/${expenseId}/receipts/${receiptId}`).then((r) => r.data),

  getMessages: (expenseId: string) =>
    client.get<{ messages: ExpenseMessage[] }>(`/expenses/${expenseId}/messages`).then((r) => r.data.messages),

  postMessage: (expenseId: string, body: string) =>
    client.post<{ message: ExpenseMessage }>(`/expenses/${expenseId}/messages`, { body }).then((r) => r.data.message),
};

export const accountantApi = {
  queue: (status?: string) =>
    client.get<{ expenses: Expense[] }>('/accountant/queue', { params: status ? { status } : undefined }).then((r) => r.data.expenses),

  all: () =>
    client.get<{ expenses: Expense[] }>('/accountant/expenses').then((r) => r.data.expenses),

  review: (id: string, data: {
    action: 'approve' | 'reject' | 'request_info';
    note?: string;
    zohoEntity?: string;
    requestType?: string;
    internalNote?: string;
  }) =>
    client.patch<{ expense: Expense }>(`/accountant/expenses/${id}/review`, data).then((r) => r.data.expense),

  updateReimbursement: (id: string, data: { status: string; note?: string }) =>
    client.patch<{ expense: Expense }>(`/accountant/expenses/${id}/reimbursement`, data).then((r) => r.data.expense),

  setZohoEntity: (id: string, zohoEntity: string) =>
    client.patch<{ expense: Expense }>(`/accountant/expenses/${id}/zoho-entity`, { zohoEntity }).then((r) => r.data.expense),

  pushToZoho: (id: string) =>
    client.post(`/accountant/expenses/${id}/zoho-push`).then((r) => r.data),

  resolveRequest: (id: string) =>
    client.post(`/accountant/expenses/${id}/resolve-request`).then((r) => r.data),

  claim: (id: string) =>
    client.post<{ expense: Expense }>(`/accountant/expenses/${id}/claim`).then((r) => r.data.expense),

  releaseClaim: (id: string) =>
    client.post<{ expense: Expense }>(`/accountant/expenses/${id}/release-claim`).then((r) => r.data.expense),

  queueSummary: () =>
    client.get<{ counts: Record<string, number> }>('/accountant/queue/summary').then((r) => r.data.counts),

  getAuditTrail: (id: string) =>
    client.get<{ entries: AuditLogEntry[] }>(`/accountant/expenses/${id}/audit`).then((r) => r.data.entries),
};

export const paymentMethodsApi = {
  list: () =>
    client.get<{ paymentMethods: PaymentMethod[] }>('/payment-methods').then((r) => r.data.paymentMethods),

  create: (data: {
    label: string;
    lastFour?: string;
    brand?: string;
    zohoAccountName?: string;
    isCompanyWide?: boolean;
    assignedUserId?: string;
  }) =>
    client.post<{ paymentMethod: PaymentMethod }>('/payment-methods', data).then((r) => r.data.paymentMethod),

  update: (id: string, data: {
    label?: string;
    lastFour?: string;
    brand?: string;
    zohoAccountName?: string;
    isCompanyWide?: boolean;
    isActive?: boolean;
  }) =>
    client.patch<{ paymentMethod: PaymentMethod }>(`/payment-methods/${id}`, data).then((r) => r.data.paymentMethod),
};
