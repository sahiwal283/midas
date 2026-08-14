import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler } from './middleware/error';
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import expensesRouter from './routes/expenses';
import receiptsRouter from './routes/receipts';
import messagesRouter from './routes/messages';
import capturesRouter from './routes/captures';
import filesRouter from './routes/files';
import accountantRouter from './routes/accountant';
import adminRouter from './routes/admin';
import extRouter from './routes/ext';
import extensionRouter from './routes/extensionExpenses';
import paymentMethodsRouter from './routes/paymentMethods';
import partnerExpensesRouter from './routes/partnerExpenses';
import reportsRouter from './routes/reports';
import budgetsRouter from './routes/budgets';
import companiesRouter from './routes/companies';
import vendorsRouter from './routes/vendors';
import metaRouter from './routes/meta';
import notificationsRouter from './routes/notifications';
import oidcAuthRouter from './routes/oidcAuth';
import transactionsRouter from './routes/transactions';
import zohoRouter from './routes/zoho';
import zohoServiceRouter from './routes/zohoService';

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Allow the configured web origin AND browser extension origins.
// When EXTENSION_ORIGIN_ALLOWLIST is set, only those extension origins are accepted.
// When empty, any chrome-extension:// / moz-extension:// origin is allowed (LAN/beta).
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin / curl
    if (origin === env.CORS_ORIGIN) return callback(null, true);
    const isExt = origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
    if (isExt) {
      const allow = env.EXTENSION_ORIGIN_ALLOWLIST;
      if (allow.length === 0 || allow.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS: extension origin ${origin} not in EXTENSION_ORIGIN_ALLOWLIST`));
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// ── Body parsing + cookies ────────────────────────────────────────────────────
// Import batches with base64 receipts need a large limit (see docs/TRADE_SHOW_MIGRATION_REPLY.md).
app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: env.JSON_BODY_LIMIT }));
app.use(cookieParser());

// ── Logging ───────────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.debug({ method: req.method, url: req.url }, 'Incoming request');
  next();
});

// ── Auth rate limit ───────────────────────────────────────────────────────────
// Configurable via AUTH_RATE_LIMIT_MAX. Default 20 (production-safe).
// Set to 200 in .env for dev/LAN environments to prevent operator lockout during testing.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: env.AUTH_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false });
app.use('/api/v1/auth/login', authLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/auth', oidcAuthRouter);
app.use('/api/v1/expenses', expensesRouter);
app.use('/api/v1/transactions', transactionsRouter);
app.use('/api/v1/expenses/:expenseId/receipts', receiptsRouter);
app.use('/api/v1/expenses/:expenseId/messages', messagesRouter);
app.use('/api/v1/captures', capturesRouter);
app.use('/api/v1/files', filesRouter); // authenticated receipt/capture streaming (no public /uploads)
app.use('/api/v1/accountant', accountantRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/ext', extRouter);             // app-to-app API (Bearer API key auth)
app.use('/api/v1/extension', extensionRouter); // browser extension (session cookie auth)
app.use('/api/v1/payment-methods', paymentMethodsRouter);
app.use('/api/v1/partner-expenses', partnerExpensesRouter);
app.use('/api/v1/reports', reportsRouter);
app.use('/api/v1/budgets', budgetsRouter);
app.use('/api/v1/companies', companiesRouter);
app.use('/api/v1/vendors', vendorsRouter);
app.use('/api/v1/expenses', zohoRouter);
app.use('/api/v1/zoho', zohoServiceRouter);
app.use('/api/v1/meta', metaRouter);
app.use('/api/v1/notifications', notificationsRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(env.PORT, env.HOST, () => {
  logger.info(`Midas API listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
  logger.info(`OCR mode: ${env.OCR_MODE} | Zoho mode: ${env.ZOHO_MODE} | Storage: ${env.STORAGE_MODE}`);
  logger.info(`Web base (midasUrl): ${env.MIDAS_WEB_BASE_URL || env.CORS_ORIGIN}`);
});

export { app };
