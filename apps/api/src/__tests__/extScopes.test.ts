import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireScope } from '../middleware/requireScope';

function mockRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe('requireScope', () => {
  it('returns 403 MISSING_SCOPE when permission absent', () => {
    const middleware = requireScope('expenses:create');
    const req = {
      appConnection: { permissions: ['expenses:read'] },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: 'MISSING_SCOPE',
        message: 'Missing required scope(s): expenses:create',
      },
    });
  });

  it('calls next when scope is granted', () => {
    const middleware = requireScope('ocr:process');
    const req = {
      appConnection: { permissions: ['ocr:process', 'expenses:read'] },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
