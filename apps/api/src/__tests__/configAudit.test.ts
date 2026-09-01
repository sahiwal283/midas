import { describe, it, expect } from 'vitest';
import {
  auditProductionConfig,
  authentikGroupsLookUnconfigured,
  PRODUCTION_REQUIREMENTS,
} from '../lib/configAudit';

const fullProdConfig = {
  VAPID_PUBLIC_KEY: 'pub',
  VAPID_PRIVATE_KEY: 'priv',
  PAYROLL_DATABASE_URL: 'postgresql://payroll@host/payroll',
  TRADESHOW_DATABASE_URL: 'postgresql://midas_ro@host/expense_app_production',
  ZOHO_SERVICE_TOKEN: 'token',
  ZOHO_SERVICE_BASE_URL: 'http://zoho:8000',
};

describe('auditProductionConfig', () => {
  it('passes when every production key is set', () => {
    const result = auditProductionConfig(fullProdConfig, { production: true });
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('never complains outside production', () => {
    const result = auditProductionConfig({}, { production: false });
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('reports the exact rollback that hit prod on 2026-08-24', () => {
    const rolledBack = { ...fullProdConfig };
    for (const k of [
      'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
      'PAYROLL_DATABASE_URL', 'TRADESHOW_DATABASE_URL',
    ]) delete (rolledBack as Record<string, unknown>)[k];

    const result = auditProductionConfig(rolledBack, { production: true });
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.feature)).toEqual([
      'Web push notifications',
      'Cashbook payroll drawer',
      'Trade show event calendar',
    ]);
  });

  it('names only the keys that are actually absent', () => {
    const partial = { ...fullProdConfig, VAPID_PRIVATE_KEY: '' };
    const result = auditProductionConfig(partial, { production: true });
    expect(result.missing).toEqual([
      { keys: ['VAPID_PRIVATE_KEY'], feature: 'Web push notifications' },
    ]);
  });

  it('treats whitespace-only values as missing', () => {
    const result = auditProductionConfig(
      { ...fullProdConfig, TRADESHOW_DATABASE_URL: '   ' },
      { production: true },
    );
    expect(result.missing.map((m) => m.feature)).toEqual(['Trade show event calendar']);
  });

  it('covers every documented requirement when nothing is set', () => {
    const result = auditProductionConfig({}, { production: true });
    expect(result.missing).toHaveLength(PRODUCTION_REQUIREMENTS.length);
  });
});

describe('authentikGroupsLookUnconfigured', () => {
  it('flags lists left at the built-in defaults', () => {
    const flagged = authentikGroupsLookUnconfigured({
      AUTHENTIK_GROUP_ADMIN: ['app-midas-admins', 'midas-admins'],
      AUTHENTIK_GROUP_ACCOUNTANT: ['app-midas-accountants', 'midas-accountants'],
      AUTHENTIK_GROUP_USER: ['app-midas-users', 'midas-users'],
    });
    expect(flagged).toEqual([
      'AUTHENTIK_GROUP_ADMIN',
      'AUTHENTIK_GROUP_ACCOUNTANT',
      'AUTHENTIK_GROUP_USER',
    ]);
  });

  it('is satisfied once real group names are appended', () => {
    const flagged = authentikGroupsLookUnconfigured({
      AUTHENTIK_GROUP_ADMIN: ['app-midas-admins', 'midas-admins', 'IT'],
      AUTHENTIK_GROUP_ACCOUNTANT: ['app-midas-accountants', 'midas-accountants', 'Accounting'],
      AUTHENTIK_GROUP_USER: ['app-midas-users', 'midas-users', 'employee', 'Employees'],
    });
    expect(flagged).toEqual([]);
  });

  it('flags the accountant list that locked riteshk out', () => {
    const flagged = authentikGroupsLookUnconfigured({
      AUTHENTIK_GROUP_ADMIN: ['app-midas-admins', 'midas-admins', 'IT'],
      AUTHENTIK_GROUP_ACCOUNTANT: ['app-midas-accountants', 'midas-accountants'],
      AUTHENTIK_GROUP_USER: ['app-midas-users', 'midas-users', 'employee', 'Employees'],
    });
    expect(flagged).toEqual(['AUTHENTIK_GROUP_ACCOUNTANT']);
  });

  it('flags an empty list', () => {
    expect(authentikGroupsLookUnconfigured({ AUTHENTIK_GROUP_ADMIN: [] }))
      .toContain('AUTHENTIK_GROUP_ADMIN');
  });
});
