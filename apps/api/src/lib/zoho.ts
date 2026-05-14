import { env } from '../config/env';
import { logger } from './logger';

export interface ZohoPushPayload {
  expenseId: string;
  zohoEntity: string;
  merchant: string;
  amount: string;
  currency: string;
  date: string;
  description?: string | null;
  receiptPath?: string;
}

export interface ZohoPushResult {
  zohoExpenseId: string;
  syncedAt: Date;
}

export interface ZohoAdapter {
  pushExpense(payload: ZohoPushPayload): Promise<ZohoPushResult>;
}

// Mock adapter — no external calls. Logs + returns fake Zoho ID.
class MockZohoAdapter implements ZohoAdapter {
  async pushExpense(payload: ZohoPushPayload): Promise<ZohoPushResult> {
    logger.debug({ payload }, 'Zoho mock: would push expense to Zoho');
    return {
      zohoExpenseId: `MOCK-ZOHO-${Date.now()}`,
      syncedAt: new Date(),
    };
  }
}

// Service adapter — calls your separate Zoho Integration Service.
// Never implement Zoho OAuth inside Midas; that belongs in the integration service.
class ServiceZohoAdapter implements ZohoAdapter {
  async pushExpense(payload: ZohoPushPayload): Promise<ZohoPushResult> {
    if (!env.ZOHO_SERVICE_URL) throw new Error('ZOHO_SERVICE_URL is not configured');
    const res = await fetch(`${env.ZOHO_SERVICE_URL}/expenses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ZOHO_SERVICE_TOKEN ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Zoho service returned ${res.status}: ${body}`);
    }
    const data = await res.json() as { zohoExpenseId: string };
    return { zohoExpenseId: data.zohoExpenseId, syncedAt: new Date() };
  }
}

export const zoho: ZohoAdapter =
  env.ZOHO_MODE === 'service' ? new ServiceZohoAdapter() : new MockZohoAdapter();
