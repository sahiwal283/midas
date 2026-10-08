// apps/api/src/__tests__/notifyHandOff.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => {
  const returning = vi.fn(async () => [{ id: 'n-1' }]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const findFirst = vi.fn(async () => ({ email: 'owner@x.test', role: 'user' }));
  return { returning, values, insert, findFirst };
});
vi.mock('../db/index', () => ({
  db: { query: { users: { findFirst: dbMock.findFirst } }, insert: dbMock.insert, update: vi.fn() },
}));
vi.mock('../config/env', () => ({ env: { CORS_ORIGIN: 'http://midas.test', MIDAS_WEB_BASE_URL: '' } }));
vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/email', () => ({ sendEmail: vi.fn(async () => true) }));
vi.mock('../lib/push', () => ({ sendPushToUser: vi.fn(async () => undefined) }));
vi.mock('../lib/extEventsDb', () => ({ loadHandOffContext: vi.fn(), recordExtEvent: vi.fn(async () => undefined) }));
vi.mock('../lib/extPing', () => ({ sendPings: vi.fn(async () => undefined) }));

import { notifyUser } from '../lib/notify';
import { loadHandOffContext, recordExtEvent } from '../lib/extEventsDb';
import { sendPings } from '../lib/extPing';
import { sendPushToUser } from '../lib/push';
import { sendEmail } from '../lib/email';
import { logger } from '../lib/logger';

const expense = {
  id: 'e-1', userId: 'owner', sourceApp: 'trade_show', sourceRefId: 'argo-exp-1',
  externalUserId: 'argo-user-1', merchant: 'Staples', amount: '42.10', status: 'rejected',
};
const input = { expenseId: 'e-1', merchant: 'Staples', amount: '42.10', note: 'Duplicate submission' };
const flush = () => new Promise((r) => setImmediate(r));

describe('notifyUser hand-off', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records one event, pings, and delivers nothing natively', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce({ expense, eventsEnabled: true, pingUrls: ['http://argo.test/ping'] });
    await notifyUser('owner', 'rejected', input);
    await flush();
    expect(recordExtEvent).toHaveBeenCalledTimes(1);
    expect(recordExtEvent).toHaveBeenCalledWith({
      sourceApp: 'trade_show', type: 'rejected', expenseId: 'e-1',
      payload: {
        externalUserId: 'argo-user-1',
        expense: { id: 'e-1', sourceRefId: 'argo-exp-1', merchant: 'Staples', amount: '42.10', status: 'rejected' },
        note: 'Duplicate submission',
      },
    });
    expect(sendPings).toHaveBeenCalledWith(['http://argo.test/ping']);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('carries the message fields for a conversation event', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce({ expense, eventsEnabled: true, pingUrls: [] });
    await notifyUser('owner', 'message', { ...input, note: undefined, senderName: 'Rita', excerpt: 'Which show?', messageId: 'm-1' }, { email: false });
    expect(vi.mocked(recordExtEvent).mock.calls[0][0].payload).toEqual(expect.objectContaining({
      senderName: 'Rita', excerpt: 'Which show?', messageId: 'm-1',
    }));
  });

  it('delivers natively, exactly as before, when the switch is off', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce({ expense, eventsEnabled: false, pingUrls: [] });
    await notifyUser('owner', 'rejected', input);
    await flush();
    expect(recordExtEvent).not.toHaveBeenCalled();
    expect(sendPings).not.toHaveBeenCalled();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(dbMock.values).toHaveBeenCalledWith(expect.objectContaining({
      type: 'rejected',
      title: 'Expense rejected',
      body: 'Your $42.10 expense at Staples was rejected. Note: Duplicate submission',
    }));
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it('falls back to native delivery when the pre-check fails', async () => {
    vi.mocked(loadHandOffContext).mockRejectedValueOnce(new Error('column missing'));
    await expect(notifyUser('owner', 'rejected', input)).resolves.toBeUndefined();
    await flush();
    expect(recordExtEvent).not.toHaveBeenCalled();
    expect(sendPings).not.toHaveBeenCalled();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('delivers natively to a non-owner even when the switch is on (a staff reply recipient)', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce({ expense, eventsEnabled: true, pingUrls: ['http://argo.test/ping'] });
    await notifyUser('accountant-1', 'message', { ...input, ownerId: 'owner', toStaff: true }, { email: false });
    expect(recordExtEvent).not.toHaveBeenCalled();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('delivers natively when the expense has gone', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce(null);
    await notifyUser('owner', 'approved', input);
    expect(recordExtEvent).not.toHaveBeenCalled();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('never throws and sends nothing natively when the outbox write fails', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce({ expense, eventsEnabled: true, pingUrls: ['http://argo.test/ping'] });
    vi.mocked(recordExtEvent).mockRejectedValueOnce(new Error('db down'));
    await expect(notifyUser('owner', 'approved', input)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    expect(sendPings).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});
