import { describe, it, expect } from 'vitest';
import { connectionSourceApp } from '../lib/ext/connectionScope';

describe('connectionSourceApp', () => {
  it('prefers an explicit source_app over the connection name', () => {
    expect(connectionSourceApp({ appName: 'trade_show_prod', sourceApp: 'trade_show' }))
      .toBe('trade_show');
  });

  it('lets several connections share one source app', () => {
    const prod = connectionSourceApp({ appName: 'trade_show_prod', sourceApp: 'trade_show' });
    const sandbox = connectionSourceApp({ appName: 'trade_show', sourceApp: 'trade_show' });
    expect(prod).toBe(sandbox);
  });

  it('falls back to the connection name when source_app is null', () => {
    expect(connectionSourceApp({ appName: 'some_app', sourceApp: null })).toBe('some_app');
  });

  it('falls back when source_app is absent entirely', () => {
    expect(connectionSourceApp({ appName: 'some_app' })).toBe('some_app');
  });

  it('returns empty string for a missing connection rather than throwing', () => {
    expect(connectionSourceApp(undefined)).toBe('');
    expect(connectionSourceApp(null)).toBe('');
  });
});
