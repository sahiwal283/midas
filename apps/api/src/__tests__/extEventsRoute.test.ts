import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/extEvents.json';

vi.mock('../lib/extEventsDb', () => ({ listExtEvents: vi.fn() }));

import { listExtEvents } from '../lib/extEventsDb';
import { buildEventsPage } from '../routes/extEventsHandler';

const rows = fixture.rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })) as never[];
const conn = { appName: 'trade_show_prod', sourceApp: 'trade_show' };

describe('buildEventsPage (GET /ext/events)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for the connection\'s own source app, after the cursor, and returns the contract shape', async () => {
    vi.mocked(listExtEvents).mockResolvedValueOnce(rows);
    const page = await buildEventsPage(conn, { since: '40', limit: '50' });
    expect(listExtEvents).toHaveBeenCalledWith('trade_show', 40, 50);
    expect(page).toEqual({ ok: true, body: { events: fixture.events, nextCursor: '45' } });
  });

  it('returns a null cursor for an empty page', async () => {
    vi.mocked(listExtEvents).mockResolvedValueOnce([]);
    expect(await buildEventsPage(conn, {})).toEqual({ ok: true, body: { events: [], nextCursor: null } });
    expect(listExtEvents).toHaveBeenCalledWith('trade_show', 0, 100);
  });

  it('rejects a bad cursor without querying', async () => {
    expect(await buildEventsPage(conn, { since: 'abc' })).toEqual({ ok: false });
    expect(listExtEvents).not.toHaveBeenCalled();
  });

  it('clamps an oversized limit', async () => {
    vi.mocked(listExtEvents).mockResolvedValueOnce([]);
    await buildEventsPage(conn, { limit: '100000' });
    expect(listExtEvents).toHaveBeenCalledWith('trade_show', 0, 200);
  });

  it('falls back to the app name when the connection has no source app', async () => {
    vi.mocked(listExtEvents).mockResolvedValueOnce([]);
    await buildEventsPage({ appName: 'trade_show', sourceApp: null }, {});
    expect(listExtEvents).toHaveBeenCalledWith('trade_show', 0, 100);
  });
});
