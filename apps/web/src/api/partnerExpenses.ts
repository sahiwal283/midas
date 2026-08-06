import client from './client';
import type { PartnerExpense, PartnerExpenseCategory } from '../types';

export const partnerExpenseApi = {
  list: () =>
    client.get<{ partnerExpenses: PartnerExpense[] }>('/partner-expenses')
      .then((r) => r.data.partnerExpenses),

  create: (data: { amount: number; itemLocation: string; category: PartnerExpenseCategory }) =>
    client.post<{ partnerExpense: PartnerExpense }>('/partner-expenses', data)
      .then((r) => r.data.partnerExpense),
};
