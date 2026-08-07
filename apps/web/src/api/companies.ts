import client from './client';
import type { Company } from '../types';

export const companyApi = {
  /** Active companies for pickers (any authenticated user). */
  list: () =>
    client.get<{ companies: Company[] }>('/companies').then((r) => r.data.companies),

  adminList: () =>
    client.get<{ companies: Company[] }>('/admin/companies').then((r) => r.data.companies),

  create: (data: { name: string; zohoEnabled?: boolean; sortOrder?: number }) =>
    client.post<{ company: Company }>('/admin/companies', data).then((r) => r.data.company),

  update: (id: string, data: Partial<{ name: string; zohoEnabled: boolean; isActive: boolean; sortOrder: number }>) =>
    client.patch<{ company: Company }>(`/admin/companies/${id}`, data).then((r) => r.data.company),
};
