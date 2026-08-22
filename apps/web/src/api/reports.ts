import client from './client';

export interface ReportRow { name: string; spend: number; count: number }

export interface EventReportRow extends ReportRow {
  /** Per-company split, largest first — powers the show tile stacked bars. */
  entities: Array<{ name: string; spend: number }>;
}

export interface EventBreakdown {
  event: string;
  totals: { spend: number; count: number; approved: number; pending: number };
  byEntity: Array<{ name: string; spend: number; count: number }>;
  categories: Array<{ category: string; byEntity: Record<string, number>; total: number }>;
  expenses: Array<{
    id: string;
    date: string;
    merchant: string;
    description: string | null;
    amount: number;
    status: string;
    reimbursementStatus: string;
    zohoEntity: string | null;
    categoryName: string | null;
    paymentMethod: string | null;
    userName: string | null;
  }>;
}

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
  byEvent?: EventReportRow[];
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

  eventBreakdown: (event: string) =>
    client.get<EventBreakdown>('/reports/event-breakdown', { params: { event } }).then((r) => r.data),
};
