import client from './client';

export interface ReportRow { name: string; spend: number; count: number }

export interface ReportSummary {
  totals: {
    spend: number;
    count: number;
    avg: number;
    reimbursementPending: number;
    largest: number;
    smallest: number;
  };
  byTransactionType?: Array<{ type: string; spend: number; count: number }>;
  ops?: {
    pendingReview: number;
    awaitingInfo: number;
    zohoFailed: number;
    ocrNeedsReview: number;
    purchaseOrdersOpen: number;
  };
  budgets?: Array<{
    id: string;
    companyName: string;
    period: string;
    budget: number;
    spend: number;
    remaining: number;
    categoryId: string | null;
    categoryName: string | null;
    notes: string | null;
  }>;
  granularity: 'week' | 'month';
  byPeriod: Array<{ period: string; label: string; spend: number; count: number }>;
  byCategory: ReportRow[];
  byEntity: ReportRow[];
  bySourceApp?: ReportRow[];
  byEvent?: ReportRow[];
  byPaymentMethod: ReportRow[];
  topVendors: ReportRow[];
  topUsers: ReportRow[];
  reimbursement: {
    reimbursableTotal: number;
    companyCardTotal: number;
    outstanding: number;
    paid: number;
    byEmployee: Array<{ name: string; outstanding: number; paid: number }>;
  };
}

export type ReportType = 'daily' | 'event';

export const reportApi = {
  summary: (p: { from: string; to: string; entity?: string; type: ReportType }) =>
    client.get<ReportSummary>('/reports/summary', { params: p }).then((r) => r.data),
};
