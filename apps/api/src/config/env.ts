import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  COOKIE_SECURE: z.string().transform((v) => v === 'true').default('false'),
  COOKIE_DOMAIN: z.string().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  UPLOADS_DIR: z.string().default('./uploads'),
  // ── OCR integration ────────────────────────────────────────────────────────
  OCR_MODE: z.enum(['mock', 'service']).default('mock'),
  // Primary names (v0.10.0+ contract)
  OCR_BASE_URL: z.string().optional(),
  OCR_SERVICE_INTERNAL_TOKEN: z.string().optional(),
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  OCR_CLIENT_APP: z.string().default('midas'),
  OCR_WORKFLOW: z.string().default('receipt-ocr'),
  OCR_EXTERNAL_REF_TYPE: z.string().default('expense_receipt'),
  // Deprecated aliases — kept for backward compatibility during transition
  // Remove after all environments are updated to the primary names above.
  OCR_SERVICE_URL: z.string().optional(),   // deprecated: use OCR_BASE_URL
  OCR_SERVICE_TOKEN: z.string().optional(), // deprecated: use OCR_SERVICE_INTERNAL_TOKEN
  // ── Zoho integration ───────────────────────────────────────────────────────
  ZOHO_MODE: z.enum(['mock', 'service']).default('mock'),
  ZOHO_SERVICE_URL: z.string().optional(),
  ZOHO_SERVICE_TOKEN: z.string().optional(),
  STORAGE_MODE: z.enum(['local', 's3']).default('local'),
  // Optional integrations
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  // Auth rate limiting — max login attempts per 15-minute window per IP.
  // Default 20 is appropriate for production; set 200 in .env for dev/LAN.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  // SSO bootstrap from Coruscant (optional)
  AUTH_MODE: z.enum(['local', 'sso']).default('local'),
  PLATFORM_JWT_SECRET: z.string().optional(),
}).refine(
  (data) => {
    if (data.OCR_MODE !== 'service') return true;
    // When service mode is active, require either the new names or the deprecated aliases.
    const hasUrl = Boolean(data.OCR_BASE_URL ?? data.OCR_SERVICE_URL);
    const hasToken = Boolean(data.OCR_SERVICE_INTERNAL_TOKEN ?? data.OCR_SERVICE_TOKEN);
    return hasUrl && hasToken;
  },
  {
    message: 'OCR_MODE=service requires OCR_BASE_URL and OCR_SERVICE_INTERNAL_TOKEN to be set',
    path: ['OCR_BASE_URL'],
  },
);

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

// Resolve deprecated aliases into the primary names so all downstream code
// uses a single consistent set of keys.
const raw = parsed.data;
export const env = {
  ...raw,
  OCR_BASE_URL: raw.OCR_BASE_URL ?? raw.OCR_SERVICE_URL,
  OCR_SERVICE_INTERNAL_TOKEN: raw.OCR_SERVICE_INTERNAL_TOKEN ?? raw.OCR_SERVICE_TOKEN,
};

// Exported for unit testing only — do not use in application code.
export const _envSchema = schema;
