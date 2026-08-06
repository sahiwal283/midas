import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import multer from 'multer';
import { logger } from '../lib/logger';
import { mapOcrError } from '../lib/mapOcrError';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  /** Extra fields merged into the JSON error body (e.g. { counts }). */
  extras?: Record<string, unknown>;
}

export function errorHandler(err: AppError, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: err.flatten().fieldErrors,
      },
    });
    return;
  }

  // Multer size/type errors should be client errors, not 500s
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.code;
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'File exceeds 10 MB limit'
      : err.message;
    res.status(status).json({ error: { code, message } });
    return;
  }

  // OCR client errors (invalid file → 400; upstream → 502/503/504 — never bare INTERNAL_ERROR)
  const ocrMapped = mapOcrError(err);
  const status = ocrMapped?.statusCode ?? err.statusCode ?? 500;
  const code = ocrMapped?.code ?? err.code ?? 'INTERNAL_ERROR';
  const message = ocrMapped?.message
    ?? (status < 500 ? err.message : 'Internal server error');

  if (status >= 500) {
    logger.error({ err, url: req.url, method: req.method }, 'Unhandled error');
  }

  const existingResId = res.getHeader('X-Request-Id');
  const requestId = (typeof existingResId === 'string' && existingResId)
    || req.header('x-request-id')
    || req.header('x-correlation-id')
    || undefined;
  if (requestId) res.setHeader('X-Request-Id', requestId);

  res.status(status).json({
    error: {
      code,
      message,
      ...(err.extras ?? {}),
      ...(requestId ? { requestId } : {}),
    },
  });
}

export function createError(
  message: string,
  statusCode: number,
  code: string,
  extras?: Record<string, unknown>,
): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  err.code = code;
  if (extras) err.extras = extras;
  return err;
}

export function notFound(message = 'Not found') {
  return createError(message, 404, 'NOT_FOUND');
}

export function forbidden(message = 'Forbidden') {
  return createError(message, 403, 'FORBIDDEN');
}

// Wraps async route handlers so errors propagate to errorHandler
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
