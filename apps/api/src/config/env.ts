import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Sliding sessions: tokens live 30 days; any use after 24h re-issues.
  JWT_EXPIRES_IN: z.string().default('30d'),
  COOKIE_SECURE: z.string().transform((v) => v === 'true').default('false'),
  COOKIE_DOMAIN: z.string().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  // Absolute web base for Ext midasUrl links (accountants open these from Trade Show).
  // Falls back to CORS_ORIGIN when unset.
  MIDAS_WEB_BASE_URL: z.string().optional(),
  // Bind address for the API process (0.0.0.0 required for LAN access from CT 2600).
  HOST: z.string().default('0.0.0.0'),
  UPLOADS_DIR: z.string().default('./uploads'),
  // Max JSON body size (import batches with base64 receipts). Default 100mb.
  JSON_BODY_LIMIT: z.string().default('100mb'),
  // ── OCR integration ────────────────────────────────────────────────────────
  // Live (service) is the operational default. mock exists only for offline tests/CI.
  OCR_MODE: z.enum(['mock', 'service']).default('service'),
  // Primary names (v0.10.0+ contract)
  OCR_BASE_URL: z.string().optional(),
  OCR_SERVICE_INTERNAL_TOKEN: z.string().optional(),
  // Matches Trade Show App's OCR_TIMEOUT (120s) — Document AI fallback can be slow.
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  OCR_CLIENT_APP: z.string().default('midas'),
  OCR_WORKFLOW: z.string().default('receipt-ocr'),
  OCR_EXTERNAL_REF_TYPE: z.string().default('expense_receipt'),
  // Deprecated aliases — kept for backward compatibility during transition
  // Remove after all environments are updated to the primary names above.
  OCR_SERVICE_URL: z.string().optional(),   // deprecated: use OCR_BASE_URL
  OCR_SERVICE_TOKEN: z.string().optional(), // deprecated: use OCR_SERVICE_INTERNAL_TOKEN
  // ── Zoho integration ───────────────────────────────────────────────────────
  ZOHO_MODE: z.enum(['mock', 'service']).default('mock'),
  // Primary service config (use these for new deployments)
  ZOHO_SERVICE_BASE_URL: z.string().optional(),
  ZOHO_SERVICE_TOKEN: z.string().optional(),
  ZOHO_DEFAULT_BRAND: z.string().default('haute_brands'),
  // Dry-run gate: when true, service adapter logs the payload but skips the real POST.
  // Must be explicitly set to false before any live Zoho writes.
  ZOHO_DRY_RUN: z.string().transform((v) => v === 'true').default('true'),
  // Deprecated alias — use ZOHO_SERVICE_BASE_URL for new deployments.
  ZOHO_SERVICE_URL: z.string().optional(),
  STORAGE_MODE: z.enum(['local', 's3']).default('local'),
  // ── Email notifications ────────────────────────────────────────────────────
  // 'off' logs would-be sends; 'smtp' delivers via nodemailer using SMTP_* below.
  EMAIL_MODE: z.enum(['off', 'smtp']).default('off'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  // Optional integrations
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  // Auth rate limiting — max login attempts per 15-minute window per IP.
  // Default 20 is appropriate for production; set 200 in .env for dev/LAN.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  // ── Auth mode ──────────────────────────────────────────────────────────────
  // 'local'     — local bcrypt login only (default for pilot)
  // 'authentik' — Authentik OIDC SSO; set ALLOW_LOCAL_BREAK_GLASS=true to keep local login
  AUTH_MODE: z.enum(['local', 'authentik']).default('local'),
  ALLOW_LOCAL_BREAK_GLASS: z.string().transform((v) => v === 'true').default('false'),
  // ── Authentik OIDC (required when AUTH_MODE=authentik) ─────────────────────
  AUTHENTIK_ISSUER_URL: z.string().optional(),
  AUTHENTIK_DISCOVERY_URL: z.string().optional(),
  AUTHENTIK_CLIENT_ID: z.string().optional(),
  AUTHENTIK_CLIENT_SECRET: z.string().optional(),
  AUTHENTIK_REDIRECT_URI: z.string().optional(),
  AUTHENTIK_POST_LOGOUT_REDIRECT_URI: z.string().optional(),
  AUTHENTIK_SCOPES: z.string().default('openid profile email'),
  // Comma-separated group names in Authentik that map to each Midas role (highest-privilege wins).
  // Supports both suite-standard (app-midas-*) and legacy (midas-*) naming schemes.
  AUTHENTIK_GROUP_ADMIN: z.string().default('app-midas-admins,midas-admins'),
  AUTHENTIK_GROUP_ACCOUNTANT: z.string().default('app-midas-accountants,midas-accountants'),
  AUTHENTIK_GROUP_USER: z.string().default('app-midas-users,midas-users'),
  // When true, auto-create a Midas user on first SSO login if they are in an approved Midas group.
  // Users with no approved group are still denied regardless of this flag.
  AUTHENTIK_AUTO_CREATE_USERS: z.string().transform((v) => v === 'true').default('false'),
  // Ext API: auto-create Midas users by email on mutating calls when missing.
  // Default false (prod prefers preflight); sandbox sets true.
  EXT_AUTO_PROVISION_USERS: z.string().transform((v) => v === 'true').default('false'),
}).superRefine((data, ctx) => {
  if (data.OCR_MODE === 'service') {
    const hasUrl = Boolean(data.OCR_BASE_URL ?? data.OCR_SERVICE_URL);
    const hasToken = Boolean(data.OCR_SERVICE_INTERNAL_TOKEN ?? data.OCR_SERVICE_TOKEN);
    if (!hasUrl || !hasToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OCR_MODE=service requires OCR_BASE_URL and OCR_SERVICE_INTERNAL_TOKEN to be set',
        path: ['OCR_BASE_URL'],
      });
    }
  }
  if (data.ZOHO_MODE === 'service') {
    const hasUrl = Boolean(data.ZOHO_SERVICE_BASE_URL ?? data.ZOHO_SERVICE_URL);
    if (!hasUrl || !data.ZOHO_SERVICE_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ZOHO_MODE=service requires ZOHO_SERVICE_BASE_URL and ZOHO_SERVICE_TOKEN',
        path: ['ZOHO_SERVICE_BASE_URL'],
      });
    }
  }
  if (data.AUTH_MODE === 'authentik') {
    const required = ['AUTHENTIK_ISSUER_URL', 'AUTHENTIK_CLIENT_ID', 'AUTHENTIK_CLIENT_SECRET', 'AUTHENTIK_REDIRECT_URI'] as const;
    for (const key of required) {
      if (!data[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} is required when AUTH_MODE=authentik`,
          path: [key],
        });
      }
    }
  }
});

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
  // Resolve deprecated alias so downstream code always uses ZOHO_SERVICE_BASE_URL
  ZOHO_SERVICE_BASE_URL: raw.ZOHO_SERVICE_BASE_URL ?? raw.ZOHO_SERVICE_URL,
  // Split scope string into array for use in OIDC flow
  AUTHENTIK_SCOPES: raw.AUTHENTIK_SCOPES.split(' ').filter(Boolean),
  // Split comma-separated group lists into arrays — supports both app-midas-* and legacy midas-* names
  AUTHENTIK_GROUP_ADMIN: raw.AUTHENTIK_GROUP_ADMIN.split(',').map(s => s.trim()).filter(Boolean),
  AUTHENTIK_GROUP_ACCOUNTANT: raw.AUTHENTIK_GROUP_ACCOUNTANT.split(',').map(s => s.trim()).filter(Boolean),
  AUTHENTIK_GROUP_USER: raw.AUTHENTIK_GROUP_USER.split(',').map(s => s.trim()).filter(Boolean),
};

// Exported for unit testing only — do not use in application code.
export const _envSchema = schema;
