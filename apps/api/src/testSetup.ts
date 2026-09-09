// Fallback env for tests that import route modules (which pull in
// `db/index.ts`, which validates process.env at import time). No test may
// actually query a database — `Pool` here stays idle since nothing in
// `src/__tests__/**` runs a query — this only satisfies config/env.ts's
// module-load-time schema check so the import itself doesn't crash the
// process. Real values (local dev, CI, etc.) always win; these are only a
// floor for a bare `npm run test -w apps/api`.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test_jwt_secret_at_least_32_characters_long';
// OCR_MODE defaults to 'service', which requires OCR_BASE_URL /
// OCR_SERVICE_INTERNAL_TOKEN. 'mock' is the mode meant for offline tests.
process.env.OCR_MODE ??= 'mock';
