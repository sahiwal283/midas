import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import multer from 'multer';
import { logger } from '../lib/logger';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
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

  const status = err.statusCode ?? 500;
  const code = err.code ?? 'INTERNAL_ERROR';
  const message = status < 500 ? err.message : 'Internal server error';

  if (status >= 500) {
    logger.error({ err, url: req.url, method: req.method }, 'Unhandled error');
  }

  res.status(status).json({ error: { code, message } });
}

export function createError(message: string, statusCode: number, code: string): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  err.code = code;
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
