# Midas Product Roadmap — Full UX/Platform Review

**Date:** 2026-08-07
**Status:** Accepted direction. Sub-projects get individual specs; this document is
the master list and must stay in sync as pieces ship.

## Company model (architectural decision — settled)

Midas serves a **cluster of sister companies**, not arbitrary tenants:

- 2 companies headquartered together, staff manages both → daily + event expenses.
- 2 companies served almost exclusively through the event module (Trade Show app);
  rare daily expenses (~1%).
- Of the 4, **one company has no Zoho at all** — nothing about it syncs to Zoho.

Consequence: no `organizations` multi-tenancy tables. Instead, **company** (today's
`zohoEntity`) becomes a first-class, admin-managed concept: a `companies` table
with at minimum `name` and `zohoEnabled`. "Entity" is renamed to **Company**
everywhere in the UI. Expenses for the Zoho-less company never enter the Zoho
pipeline.

## Sub-projects (build order: A first; all planned)

### A. Employee mobile-first capture  ← IN DESIGN
- Receipt-first Add Expense wizard: Step 1 take photo / upload (camera roll or
  file) / enter manually → OCR prefills → user corrects → payment method,
  company (auto-derived from card, editable), category, notes (optional) →
  Submit (auto-pushes to the right Zoho when eligible).
- Accept HEIF/HEIC and other common phone photo formats.
- Mobile bottom navigation: Home · [camera Add, centered/prominent] · My Expenses.
  Desktop keeps the sidebar. Different information density per form factor.
- Upload queue → plain notification: "N expenses couldn't finish uploading. Tap
  to retry."
- Employee dashboard: action-first ("2 expenses need your attention" → under
  review → approved), not lifetime statistics.
- Clearer post-approval status for employees: Approved ✓ → Sent to accounting ✓ /
  Accounting complete ✓ (zoho_sync_failed shows as "Sent to accounting" pending
  retry — accounting detail is not the employee's problem).
- Entity → Company rename across employee-facing UI.

### B. Accountant workspace
- Bulk operations; bulk approval is **never blind**: confirmation summarizing
  count, total dollars, and flagged items (missing receipts, unresolved issues),
  offering "Approve N ready expenses".
- Server-side search/filtering: employee, merchant, amount, date range, category,
  payment method, status, reimbursement status, Zoho status, company, OCR needs
  review, missing receipt/category/payment, source app.
- Split-screen desktop detail: receipt left; details, Zoho readiness, conversation
  right; Approve/Reject/Ask in the header.
- Accountant dashboard: queue counts (needs review, awaiting user, Zoho failed,
  missing fields), $ ready for Zoho, reimbursement totals ($ awaiting + employee
  count).
- Bulk Zoho push: "Ready for Zoho: 17 expenses, $8,421.37 → [Push 17]" with
  per-item success/failure results.

### C. Zoho pipeline completion
- Resolve mapping decisions: category → COA, payment method → paid-through,
  reimbursable vs company card, Zoho record type, vendor policy, company
  assignment, OCR mismatch behavior, explicit vs automatic sync, duplicate
  prevention.
- Vendor policy: never auto-create vendors. Match exact → known aliases →
  ambiguous flags accountant → create only if explicitly configured.
- Company auto-derivation from `paymentMethod.defaultZohoEntity` (already stored).
- Category suggestions from merchant (expand `categoryMappings`); category
  optional for employees when inferable — accountant verifies.
- Per-expense Zoho sync history UI (created/failed, timestamp, Zoho ID, reason,
  retry) — data already stored; this is UX.
- Structured sync error codes: AUTH_ERROR, MAPPING_ERROR, VALIDATION_ERROR,
  RATE_LIMIT, NETWORK_ERROR, ZOHO_ERROR, DUPLICATE, UNKNOWN.
- Auto-retry with backoff for transient classes (network/timeout/429/5xx) only;
  data errors go straight to Zoho Failed.

### D. Expense lifecycle integrity
- State-based edit rules: draft freely; pending restricted; awaiting_info yes;
  in_review no; approved no; rejected clone-only; **Zoho-synced never silently
  editable** — corrections are explicit correction/reversal workflows.
- Rejected → "[Create corrected expense]" clones to a new draft, preserving
  accounting history.
- Duplicate detection on merchant + date + amount + user + receipt hash:
  "⚠ Possible duplicate" warning.
- Server-side pagination/search for expense lists (employee and accountant).

### E. Admin console
- Payment methods: full editing + assignment model — Company card (everyone) vs
  Assigned card (named users); employees see only their cards + company cards.
- User management: invitations (+resend), department, manager/approval manager,
  employee ID, cost center, default company, default payment method, last login,
  SSO-only enforcement, bulk operations.
- IA reorg: Company (info, companies, departments, cost centers) · People (users,
  roles, approval rules) · Expenses (categories, payment methods, policies) ·
  Integrations (Zoho, Trade Show, API connections, extension) · Security (SSO,
  sessions, audit logs).
- Admin-wide audit log UI: filter by user, action, date, expense, Zoho, admin
  actions + search (beyond the 15-entry expense view).
- Replace alert()/window.confirm() with real modals; destructive confirmations
  show impact ("This employee has 14 expenses…") and prefer Deactivate over
  Delete.

### F. Notifications
- In-app notification center + email: action required (accountant request),
  approved, rejected, reimbursement paid. Deep links to the expense.

### G. Reimbursement definition
- Manual payment is intentional → label "Mark as paid" (never "Pay employee").
- Employee reimbursement view as a My Expenses filter (Pending/Approved/Paid).
- Accountant dashboard: "$X awaiting reimbursement · N employees".
- Reports: reimbursable vs company-card totals, reimbursed, outstanding, paid,
  per-employee totals.

### H. Platform & polish
- File storage: authenticated file-stream endpoint or signed URLs (no direct
  unauthenticated /uploads exposure) for production.
- Production security pass.
- Merchant/vendor normalization (Amazon/AMAZON.COM/AMZN → one vendor).
- ~~Browser extension rework (major).~~ **Done 2026-08-10** — drag-to-crop
  capture, quick-expense form on the wizard pipeline (server-side auto-push),
  in-app distribution via `/get-extension`
  (`docs/superpowers/specs/2026-08-10-extension-rework-design.md`).
- Desktop capture app (Electron) — deferred future project: capture anything on
  screen (not just browser tabs) and feed the same expense pipeline.
- Accountant "close period" (explicitly not P0): closed periods lock edits;
  corrections become adjustment events.
- Cross-cutting UX polish, folded into each sub-project as touched: loading
  skeletons (dashboard, lists, queue, detail), proper empty states, error copy
  ("Couldn't update user — the change wasn't saved. [Try again]").
- Role-specific dashboards (employee action-first in A; accountant in B; admin
  status overview in E).
