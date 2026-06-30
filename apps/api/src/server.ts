import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler } from './middleware/error';
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import expensesRouter from './routes/expenses';
import receiptsRouter from './routes/receipts';
import messagesRouter from './routes/messages';
import capturesRouter from './routes/captures';
import accountantRouter from './routes/accountant';
import adminRouter from './routes/admin';
import extRouter from './routes/ext';
import extensionRouter from './routes/extensionExpenses';
import paymentMethodsRouter from './routes/paymentMethods';
import metaRouter from './routes/meta';
import zohoRouter from './routes/zoho';

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Allow the configured web origin AND browser extension origins (chrome-extension:// / moz-extension://).
// Extension origins cannot be enumerated ahead of time (ID changes per install), so we allow
// the scheme prefix. This is acceptable because the extension still requires a valid session cookie.
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin / curl
    if (origin === env.CORS_ORIGIN) return callback(null, true);
    if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// ── Body parsing + cookies ────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' })); // extension sends base64 images
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Logging ───────────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.debug({ method: req.method, url: req.url }, 'Incoming request');
  next();
});

// ── Static uploads ────────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.resolve(env.UPLOADS_DIR)));

// ── Auth rate limit ───────────────────────────────────────────────────────────
// Configurable via AUTH_RATE_LIMIT_MAX. Default 20 (production-safe).
// Set to 200 in .env for dev/LAN environments to prevent operator lockout during testing.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: env.AUTH_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false });
app.use('/api/v1/auth/login', authLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/expenses', expensesRouter);
app.use('/api/v1/expenses/:expenseId/receipts', receiptsRouter);
app.use('/api/v1/expenses/:expenseId/messages', messagesRouter);
app.use('/api/v1/captures', capturesRouter);
app.use('/api/v1/accountant', accountantRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/ext', extRouter);             // app-to-app API (Bearer API key auth)
app.use('/api/v1/extension', extensionRouter); // browser extension (session cookie auth)
app.use('/api/v1/payment-methods', paymentMethodsRouter);
app.use('/api/v1/expenses', zohoRouter); // GET /expenses/:id/zoho-readiness
app.use('/api/v1/meta', metaRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(env.PORT, () => {
  logger.info(`Midas API running on port ${env.PORT} (${env.NODE_ENV})`);
  logger.info(`OCR mode: ${env.OCR_MODE} | Zoho mode: ${env.ZOHO_MODE} | Storage: ${env.STORAGE_MODE}`);
});

export { app };
