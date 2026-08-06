import client from './client';

export interface ReportRow { name: string; spend: number; count: number }

export interface ReportSummary {
  totals: { spend: number; count: number; avg: number; reimbursementPending: number };
  granularity: 'week' | 'month';
  byPeriod: Array<{ period: string; label: string; spend: number; count: number }>;
  byCategory: ReportRow[];
  byEntity: ReportRow[];
  byPaymentMethod: ReportRow[];
  topVendors: ReportRow[];
  topUsers: ReportRow[];
}

export type ReportType = 'daily' | 'event';

export const reportApi = {
  summary: (p: { from: string; to: string; entity?: string; type?: ReportType }) =>
    client.get<ReportSummary>('/reports/summary', { params: p }).then((r) => r.data),
};
