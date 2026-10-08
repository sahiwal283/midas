import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../config/env', () => ({ env: { EXT_EVENTS_PING_SECRET: 'shh' } }));
vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { env } from '../config/env';
import { signPing, sendPings } from '../lib/extPing';

describe('signPing', () => {
  it('is the hex HMAC-SHA256 of the timestamp string', () => {
    const expected = crypto.createHmac('sha256', 'shh').update('1760000000').digest('hex');
    expect(signPing('shh', '1760000000')).toBe(expected);
  });
});

describe('sendPings', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);
    (env as { EXT_EVENTS_PING_SECRET?: string }).EXT_EVENTS_PING_SECRET = 'shh';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs an empty JSON body with a timestamp and its signature, and no expense data', async () => {
    await sendPings(['http://argo.test/api/midas/events-ping']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://argo.test/api/midas/events-ping');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    const ts = init.headers['X-Midas-Timestamp'];
    expect(ts).toMatch(/^\d{10}$/);
    expect(init.headers['X-Midas-Signature']).toBe(signPing('shh', ts));
    expect(init.signal).toBeDefined();
  });

  it('sends nothing without a secret or without URLs', async () => {
    await sendPings([]);
    (env as { EXT_EVENTS_PING_SECRET?: string }).EXT_EVENTS_PING_SECRET = undefined;
    await sendPings(['http://argo.test/x']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the other side is down, and still tries the next URL', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(sendPings(['http://a.test/x', 'http://b.test/x'])).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
