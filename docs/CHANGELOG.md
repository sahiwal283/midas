# Changelog

## 0.56.0 (2026-08-21)

### Review pages: Queue | All toggle
- Event Review and Daily Review get a pill toggle (same pattern as Reports, URL-backed via `?view=all`). **Queue** is the lane workflow as before; **All** browses every expense in that page's scope — any status — using the same list, filters, tags, and bulk actions as My Expenses, with the employee shown and filterable and rows linking to the accountant detail page.
- The "All Expenses" lane is gone from the rail and chips — the All view replaces it.

### Expenses → My Expenses
- The page is renamed **My Expenses** and now shows only your own submissions for every role; `GET /api/v1/expenses` is own-only server-side. Company-wide browsing lives under the review pages' All view.
- The whole list experience (status tabs, filter panel, chips, Trade Show/Daily tags, bulk delete) was extracted into a shared `ExpenseBrowser` component used by both surfaces.

## 0.55.0 (2026-08-19)

### Settings: Payment Methods filtered by company
- The company dropdown now shows that company's cards plus an Unassigned group. Other brands stay hidden.
- Each row has a Company control so you can move a card. Changing company clears its Zoho paid-through mapping (account ids are per org).
- Mapping a Zoho account no longer overwrites the card's company from the page filter. Add Method prefills the company you are viewing.

## 0.54.0 (2026-08-19)

### Queue actions and dashboard hierarchy
- Approve is a compact green action, not a navy block copied into every row. Reject and Needs review sit beside it as text.
- Dashboard stats use icon wells and a gold spine when something needs a reply. Recent expenses show status badges instead of gray labels.

## 0.53.0 (2026-08-19)

### UI: one professional system across every page
- List pages, queues, reports, settings, and detail views now share Midas navy / gold / cream instead of leftover Tailwind gray, teal, and blue.
- Shared page headers, panels, table headers, and primary buttons. Amounts use tabular figures. Status badges stay in the brand palette (amber only for attention).
- Charts use the same navy–gold categorical series. Checkmarks dropped from status labels.

## 0.52.2 (2026-08-19)

### Sidebar: drop Add Transaction
- The chooser is still at `/expenses/new` from the Dashboard and Expenses buttons. Mobile keeps the camera FAB.

## 0.52.1 (2026-08-19)

### Add Transaction: purchase order is a first-class choice
- Purchase order is a fourth chooser card (same size as Scan / Upload / Manual), not a footnote link. The page title matches the sidebar.

## 0.52.0 (2026-08-19)

### Review queues: Ready for Zoho count/pagination, denser professional layout
- Ready for Zoho (and Missing Company) were client-filtered leftover pages of the mixed queue, with page forced to 1. The rail could say 35, the table 4, and pagination "378 total / page 1 of 4" while Next did nothing. Those lanes now filter and paginate on the server, so the heading, table, and pager agree.
- Missing-field lanes are approved-only (matching the copy). Reimbursement includes both "needs reimbursement" and "approved pending payment".
- Layout: wrapping lane labels (no truncated "Pending appro…"), wider rail, attention vs ready count colors, tighter table rows, readable metadata, tabular amounts, "Showing 1–50 of N" pager. The bulk Zoho bar uses the lane total and pushes the current page.

## 0.51.0 (2026-08-19)

### Expense detail: safer reimbursement, recategorize after Zoho, quieter sidebar
- Reimbursement is no longer a live dropdown. Accountants see the current status plus **Change**; saving is explicit. If the expense is already in Zoho Books, a confirm step is required — Midas updates, Zoho does not.
- Accountants can recategorize from the quick-view modal and the full page (searchable picker), including expenses already pushed to Zoho. Same confirm: Midas-only, Zoho is not rewritten. This is how older "Office Supplies" rows get a more specific COA after the chart was expanded.
- Full-page Zoho readiness no longer treats "already synced" as a red X. Pushed expenses hide the checklist (the Zoho card already shows Created + ID). Unpushed expenses show only the blocking items, collapsed. Recent activity defaults to the last three events; Details is collapsed.

## 0.50.0 (2026-08-19)

### Reports: Daily vs Trade Show, never mixed
- The Reports page is two exclusive views. A pill toggle at the top switches **Daily** and **Trade Show**; there is no combined "All" and the API now requires `type=daily|event` so the two streams cannot merge.
- Layout matches the trade-show app's reports rhythm: navy hero ribbon (total + count / average / largest / outstanding), section kickers ("Where the money went", "What you've spent most on"), company total cards, horizontal category bars (donut dropped — too many COA slices), and a **Show league table** on the Trade Show view (spend by event name).
- Export CSV downloads the current view's breakdowns. Date presets and company filter stay. Queue health and budgets stay on Daily, where they belong.

## 0.49.0 (2026-08-19)

### Searchable category dropdowns
- Category pickers are now type-to-search comboboxes instead of a native `<select>` that dumps the full COA as an unscrolled list. Typing filters by category name or parent path ("parking" finds "Show Operations › Parking Fees").
- Applied everywhere a category is chosen: new expense form, expense edit, Expenses filters, Event/Daily Review filters, budget category, and the browser-extension expense form.
- Opening the picker starts a fresh search so an already-selected category no longer hides the rest of the list.

## 0.48.0 (2026-08-19)

### Users settings: one Manage button per row
- The six per-row action buttons and inline role dropdown are gone. Each row shows name, email, role + auth badge, status, last login, and a single **Manage** button that opens a detail modal.
- The modal holds everything: name + role editing (self-role locked), the org profile fields, Deactivate/Reactivate, Reset password, Resend invite (invited accounts), and a danger-zone Delete using the existing two-stage deactivate-first flow. One-time secrets (temp passwords, invite links) show inside the modal and persist above the table if the modal is closed before they're dismissed.
- UsersTab extracted from Admin.tsx into `settings/UsersSection.tsx` (Admin.tsx: 1,821 → 880 lines).

### Fixed
- **User deletion no longer fails for anyone in the audit log** (migration 0026): `audit_logs.user_id` had an `ON DELETE SET NULL` FK, but the append-only trigger rejects that UPDATE — so deleting any user who ever appeared in the audit trail crashed with a 23000. The FK is dropped; audit rows keep the actor's id as a historical snapshot, which an audit trail should do anyway.
- Removed the seed/test accounts from production (accountant/admin/developer/user/partner@midas.local). `admin@company.com` is kept deactivated: it owns transactions and an expense synced to Zoho Books, which the purge path correctly refuses to delete.

### Expenses page: robust filtering + trade-show/daily tags
- Every expense row is tagged **Trade Show** (with the event name when known, e.g. "Champs Summer LV 2026") or **Daily**, using the same rule the review pages already use (daily = entered in Midas or via the browser extension).
- New always-visible Type toggle (All / Trade Show / Daily) beside search, plus a collapsible Filters panel: date range (replaces the month dropdown), amount min/max, category, event, payment method, source, reimbursement — and employee + company for accountant/admin. Applied filters show as removable chips.

### Review pages: enterprise layout
- Desktop gets a left lane rail (Needs Attention / Missing Fields / Ready & Processing) replacing the four summary cards and three chip rows; the table starts far higher on the page. Phones keep the chip rows.
- All filters collapse behind a Filters toggle on desktop too (search stays inline); applied filters remain visible as removable chips while collapsed. Active lane shows a proper heading with its count.
- Quick actions are prominent: Approve and Push to Zoho are solid green/teal, Reject is a red outline, Needs review a neutral outline.

### Mobile: information-forward review queue and expense list
- **Review queue**: on phones, all filters except search collapse behind a Filters toggle with an active-count badge; summary stat cards are hidden (the lane chips carry the same counts); each lane group is a single scrollable chip row. The queue itself now starts near the top of the screen.
- **My Expenses**: summary cards fit one row, status tabs scroll in a single row instead of stacking, and the month/category selects share a row. Desktop unchanged on both pages.

## 0.46.1 (2026-08-18)

### Fixed
- **Mobile camera button opens the camera directly**: the bottom-nav FAB previously landed on the add-transaction chooser because browsers block programmatic file-input clicks after navigation; the capture input now lives in the nav button itself and hands the photo to the expense form (compress → draft → OCR). Cancelling the camera no longer navigates anywhere.

## 0.46.0 (2026-08-18)

### Mobile optimization + web push notifications
- **Every page optimized for phones**: mobile card lists replace desktop-only tables (accountant queue, reports, budgets, partner expenses, PO line items, admin users/companies/audit, payment methods), 44px touch targets and stacked filters throughout, safe-area support for notched iPhones, quick-view modal is a bottom sheet on mobile. Desktop rendering unchanged.
- **Web push notifications**: expense notifications (approved/rejected/action required/reimbursed) now reach phones and desktops via Web Push. Enable per device from the notification bell. New `push_subscriptions` table (migration 0025), `/notifications/push/*` routes, VAPID fan-out beside email in `notifyUser`. Requires `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` in `.env` (`npx web-push generate-vapid-keys`); silently off otherwise.
- **Installable PWA**: manifest upgraded (`standalone`, PNG icons); iOS users must Add to Home Screen to receive push. Logout unsubscribes the device.

## 0.29.0-alpha (2026-08-10)

### Purchase orders + Integration Health
- **POs skip accountant review**: submitting a purchase order approves it and pushes it to Zoho immediately (the purchasing employee is the authority). Zoho-disabled companies (Summitt Labs) just approve. Push failures appear on the accountant PO page for retry.
- **Integration Health** is admin/developer-only and moved out of the accountant section.

## 0.28.0-alpha (2026-08-10)

### Navigation consolidation
- **Add Transaction** opens the receipt wizard directly; the Expense-vs-PO chooser page is gone ("Create a purchase order instead" lives inside the wizard). Mobile camera button goes straight to scan again.
- **To Upload** removed from navigation (the tap-to-retry banner covers it; the page remains reachable from the banner).

## 0.27.1-alpha (2026-08-10)

### Extension onboarding
- The Get Extension page is gone; desktop users who don't have the extension see a dismissible setup modal instead (X to dismiss; downloading suppresses it; an installed extension auto-suppresses it via a page marker). Re-open anytime from Settings → My Account → Browser extension.

## 0.27.0-alpha (2026-08-10)

### Transactions, Purchase Orders, Budgets (landed from parallel session)
- Transaction/PO foundation: purchase orders with line items, vendors, Zoho items catalog, PO queue + detail + bulk review, Zoho PO sync parity, budgets section, integration health page, audit-log immutability triggers (migrations 0014-0016, idempotent SQL runner).
- Note: these features rode into main alongside the 0.20.1 extension fix; this release deploys both.

## 0.20.1-alpha (2026-08-10)

### Fixed
- **Extension is now zero-config**: production URLs are the built-in defaults — install, sign in to Midas, done. Options page is dev-only override.
- **Options Save actually saves**: the page used inline scripts, which Manifest V3 CSP silently blocks; moved to an external module.
- Install instructions simplified (no configuration step); duplicate feature card fixed.

## 0.27.0-alpha (2026-08-10)

### Zoho polish + PO sync parity (Phase 8 / roadmap C)
- **ZohoSyncCard**: works for expenses and POs (`recordKind`); branded; exported `ZohoErrorCategoryChip` / `parseSyncError`.
- **PO detail**: shared sync card with Retry; privileged back-link to PO queue.
- **Queues**: failed expense/PO rows show `[CATEGORY]` chips from `zohoSyncError`.
- **Integration Health**: brand polish; live/cache source on catalog probes; **Refresh catalog** → `POST /transactions/meta/sync-catalog`.

## 0.26.0-alpha (2026-08-10)

### Accountant polish + PO bulk parity (Phase 7 / roadmap B)
- **PO bulk approve**: `POST /transactions/bulk-review` + never-blind confirm (skip awaiting_info / missing lines / missing Zoho vendor or items).
- **PO bulk Zoho push**: `POST /transactions/bulk-zoho-push` sequential push with result summary.
- **PO queue UI**: multi-select, bulk actions bar, branded table.
- **Brand polish**: accountant workspace header, split-screen review header/actions, PO queue cream/ink/gold.

## 0.25.0-alpha (2026-08-10)

### Employee capture polish (Phase 6 / roadmap A)
- **Wizard**: cream/ink/gold restyle + step chrome (Choose → Details → Done); clearer OCR review panel.
- **Home**: action-first subtitle and lanes; recent list uses employee status labels.
- **Status**: employee badges show **Approved ✓** / **Accounting complete ✓**; detail passes `zohoExpenseId`.
- **Copy**: employee-facing Entity → **Company**; upload-retry banner uses brand tokens.

## 0.24.0-alpha (2026-08-10)

### Launch hardening (Phase 5) + logo polish
- **Logo**: solid two-plane geometric M mark (cream on gold plate); favicon/`logo.svg` aligned; wordmark stays title-case Fraunces.
- **CORS**: `EXTENSION_ORIGIN_ALLOWLIST` pins chrome/moz extension origins when set; empty keeps LAN/beta wildcard (documented in `.env.example` + `docs/SECURITY.md`).
- **Audit**: migration `0016_audit_immutable.sql` — DB triggers reject UPDATE/DELETE on `audit_logs`.
- **Zoho catalog**: vendor/item list write-through to `vendors` / `zoho_items` with cache fallback; `POST /transactions/meta/sync-catalog`.
- **Reports**: spend-by-source / event dimension (`bySourceApp`).
- **Ops**: `npm run zoho:smoke -w @midas/api` (dry-run by default; `ZOHO_SMOKE_WRITE=1` for live create).

## 0.23.0-alpha (2026-08-10)

### Branding + UI redesign (Phase 4)
- **Identity**: new geometric gold M mark, MIDAS wordmark, Fraunces + DM Sans, cream/ink/gold/success/danger tokens (`#C9A227` accent).
- **Chrome**: login brand-first; sidebar/mobile IA (Add Transaction, To Upload, Reimbursements, accountant + admin groups).
- **Surfaces**: cream canvas, denser headers on Dashboard / Expenses / Accountant / Reports / Settings; favicon updated.

## 0.22.0-alpha (2026-08-10)

### Phase 3 polish
- **Budgets**: `budgets` table + `/api/v1/budgets` CRUD (admin write); Settings → Budgets; Reports budget-vs-spend.
- **Vendor/item matching**: searchable combobox for Zoho vendors/items on PO create/detail.
- **Provenance**: canonical `source_type` vocabulary (`manual`, `online_receipt`, `purchase_order`, …) with normalizer.
- **Multi-company**: `zohoEntity` must match an active `companies` row (`UNKNOWN_COMPANY`).
- **Branding**: Tailwind brand scale centered on Haute gold `#C9A227`.

## 0.27.0-alpha (2026-08-10)

### Transaction + purchase-order foundation (Phases 1–2)
- **Domain model**: `transactions`, `purchase_orders`, `transaction_line_items`, `vendors`, `expense_details`; expenses dual-write into transactions; soft-cancel; `integrationStatus` split from workflow status.
- **Zoho PO adapter**: live `POST /zoho/purchaseorders/create` with Books wire body; vendor/item list parsing; push requires Zoho vendor + item IDs; contract in `docs/ZOHO_PO_CONTRACT.md`.
- **UI**: Add Transaction / New PO / PO detail & accountant PO queue; Integration Health page; OCR confidence warnings; accountant queue server pagination; reports ops KPIs + expense vs PO spend.

## 0.20.0-alpha (2026-08-10)

### Role-scoped Settings
- Payment Methods folded into Settings (Expenses group); standalone page removed (old URL redirects).
- Settings is now visible to every role, scoped: admin/developer see everything; accountants see Expenses (Categories + Payment Methods, now editable by accountants); employees/partners see My Account only.
- New **My Account**: edit your name, change your password (SSO-only accounts see an Authentik note instead). Server gates aligned per route.

## 0.19.0-alpha (2026-08-10)

### Sessions
- **Sliding 30-day sessions** (was a hard 8-hour cutoff): any use after 24h silently re-issues a fresh 30-day cookie, so active users — web and extension — stay signed in; only 30 days of inactivity logs you out. Applies to local login, SSO, and invites.

## 0.18.0-alpha (2026-08-10)

### Simplification
- **Removed the Captures page and the extension's "Save Capture" flow** — the extension is expense-only (the 30-second quick form made save-for-later redundant). The captures API and data remain server-side; the extension zip was rebuilt.

## 0.17.0-alpha (2026-08-10)

### Browser extension rework
- **Drag-to-crop capture**: snapshot the tab, drag a rectangle around the receipt (Esc / "Use full tab" to skip); crisp device-pixel cropping.
- **Quick expense form on the wizard pipeline**: draft → cropped receipt upload → OCR prefill → payment method / Company / category / notes → submit. Server-side auto-push applies — complete daily expenses approve and sync from the popup.
- **In-app distribution**: new `/get-extension` page (linked from Captures and the sidebar) with the downloadable zip and step-by-step Chrome/Edge install instructions. Fixed the extension build (previously emitted unloadable paths); manifest 0.3.0.
- Desktop capture app (Electron) recorded as a deferred future project.

## 0.16.1-alpha (2026-08-10)

### Fixed
- Test suite fully green (307/307): `mapOcrError` no longer imports env-coupled modules in tests; stale readiness/version assertions updated.

## 0.16.0-alpha (2026-08-10)

### Platform hardening
- **Receipts and captures now require authentication**: files stream through `/api/v1/files/*` (owner or accountant/admin/developer); the public `/uploads` static mount is removed. Path-traversal guarded.
- **Close periods**: accountants can close a month (`closed_periods`, migration 0013); edits, deletes, submits, reviews, and reimbursement changes on expenses in a closed month are blocked (`PERIOD_CLOSED`); admin force-delete remains as the audited override; reopen is admin-only. Corrections flow through the clone-to-new-draft path into an open period.
- **Merchant normalization** in reports: AMAZON.COM / Amazon.com*123 / AMZN now roll up as one vendor.
- **Production security checklist** added to OPERATIONS.md (incl. rotate/deactivate seeded partner@/developer@ before pilot).

## 0.15.0-alpha (2026-08-10)

### Notifications
- **In-app notifications** with a bell + unread badge (desktop sidebar and mobile header): action required (accountant request), approved, rejected, reimbursement paid. Tap → the expense; mark-all-read; 60s polling.
- **Email delivery, env-gated**: `EMAIL_MODE=smtp` + SMTP_* vars enables emails with deep links; default `off` logs only. New `nodemailer` dependency (migration 0012 adds the `notifications` table).
- Actors are never notified about their own actions; auto-approved daily expenses don't notify.

## 0.14.0-alpha (2026-08-07)

### Reimbursements
- Payment stays intentionally manual — all copy says **"Mark as paid"**; Midas never moves money.
- **Employee view**: Reimbursements filter chips (Pending/Approved/Paid) in My Expenses, with badges on rows.
- **Reports**: new Reimbursements section — reimbursable vs company-card totals, outstanding, paid, and a by-employee breakdown.
- Accountant dashboard's "$ awaiting reimbursement" now links into the queue pre-filtered to pending reimbursements.

## 0.13.0-alpha (2026-08-07)

### Admin console
- **User org profiles**: department, employee ID, cost center, manager, default company, default payment method, last login (migration 0011). Wizard pre-fills from user defaults.
- **Invitations**: invite users via one-time 7-day links (`/invite/:token` sets the password and signs in); resend supported; email delivery arrives with notifications.
- **Audit Log UI** (Admin → Security): filterable, searchable, paginated with expandable before/after JSON.
- **Payment method assignment**: cards are company-wide or assigned to a user; employees see company cards + their own; full per-card editing.
- **Admin IA reorg**: Company / People / Expenses / Integrations / Security groups; all `alert()`/`confirm()` replaced with proper modals; destructive delete prefers "Deactivate instead" and shows owned-data counts.
- **Bulk user operations**: multi-select deactivate/reactivate with confirmation (self and last-active-admin protected).

## 0.12.0-alpha (2026-08-07)

### Expense lifecycle integrity
- **State-based edit rules**: draft/awaiting_info fully editable; pending notes-only; in-review/approved/rejected locked; **Zoho-synced never editable** (`NOT_EDITABLE`). New edit card on expense detail for editable states.
- **Rejected → corrected expense**: rejected expenses show the reason + "Create corrected expense", cloning to a fresh draft without touching accounting history.
- **Duplicate detection**: submit warns "Possible duplicate" on same amount, ±3-day date, similar merchant (non-blocking, Submit anyway available).
- **Server-side list groundwork**: `GET /expenses` supports `search/from/to/status/page/pageSize` with a paged response shape (legacy shape unchanged without `page`).

## 0.11.0-alpha (2026-08-07)

### Zoho pipeline
- **Settled accounting policies** (record type, category→COA, paid-through, vendors-never-auto-created, company derivation, sync modes, idempotent dedupe, OCR-mismatch handling) — documented in `docs/ZOHO_INTEGRATION.md`.
- **Structured sync errors**: failures classified (AUTH/MAPPING/VALIDATION/RATE_LIMIT/NETWORK/ZOHO/DUPLICATE/UNKNOWN) and stored on the expense (`zoho_sync_error`).
- **Auto-retry with backoff** (2 retries: 2s/5s) for transient failures only (network/429/5xx); data errors go straight to Zoho Failed.
- **Zoho sync history card** on accountant views: Created + date + Zoho ID, or Sync failed + categorized reason + Retry. Employees never see it.
- **OCR category suggestions**: the wizard preselects the matching Zoho category from the receipt ("Suggested from the receipt — change if wrong"), never overriding a manual pick.

## 0.10.0-alpha (2026-08-07)

### Accountant workspace
- **Server-side queue filters**: employee, merchant search, amount range, date range, category, payment method, reimbursement status, Zoho status, company, source app, plus flag filters (OCR needs review, missing receipt/category/payment).
- **Safe bulk approval**: selection modal shows count, total $, and flagged items (missing receipt/category/payment, unresolved issues) — approves only the ready subset, never blind (`POST /accountant/expenses/bulk-review`).
- **Bulk Zoho push**: "Ready for Zoho — N expenses · $X → Push N" with per-item results (`POST /accountant/zoho/bulk-push`).
- **Split-screen review** at `/accountant/:id`: receipt left; details, Zoho readiness checklist, conversation right; Approve/Reject/Ask in the header.
- **Accountant dashboard**: queue counts (linking into filtered lanes), $ ready for Zoho, $ awaiting reimbursement with employee count.

## 0.9.0-alpha (2026-08-07)

### Employee mobile-first capture
- **Receipt-first Add Expense wizard**: Scan (camera) / Upload / Enter manually → OCR prefills merchant, amount, date → correct → payment method, **Company** (auto-filled from card, editable), category, notes → Submit. Success screen shows Approved vs Submitted-for-review.
- **Companies backbone**: new `companies` table (migration 0010) + Admin → Companies tab. "Entity" renamed to **Company** in employee UI. Summitt Labs is Zoho-disabled — its expenses never auto-push and always go to the accountant.
- **iPhone photos**: HEIC/HEIF accepted and converted to JPEG server-side (new `heic-convert` dependency).
- **Mobile shell**: bottom navigation (Home · camera Add · Expenses · More sheet) below `lg`; desktop sidebar unchanged. My Expenses renders as cards on phones; dashboard stats stack.
- **Upload queue simplified**: "N expenses couldn't finish uploading — Tap to retry" banner replaces the To upload nav item (page remains as the banner's Details link).
- **Action-first dashboard**: "Needs your attention" leads; lifetime total removed. Employee statuses now distinguish **Approved ✓** from **Accounting complete ✓** (synced); sync failures stay "Approved" for employees.

## 0.8.0-alpha (2026-08-06)

### Reports
- New **All / Daily / Event** type filter: daily = expenses entered in Midas or via the extension; event = expenses from external apps (Trade Show). Same boundary as the auto-push feature. Applies to every chart, KPI, and table (`type=daily|event` on `/reports/summary`).

## 0.7.0-alpha (2026-08-06)

### Reports
- New **Reports** page (accountant/admin/developer): company-wide spend with preset filters (This/Last month, This/Last quarter, Q1–Q4, YTD) + custom date range + entity filter.
- KPI tiles (total, count, average, reimbursements pending), spend-over-time bar chart (weekly buckets for short ranges), category donut, entity and payment-method breakdowns, top-10 vendors and spenders.
- New `GET /api/v1/reports/summary` aggregate endpoint (SQL GROUP BYs, zero-filled periods); scope = all non-draft, non-rejected expenses.
- New web dependency: recharts.

## 0.6.0-alpha (2026-08-06)

### Daily expense auto-push
- Complete staff-entered daily expenses (entered in Midas or via the browser extension) **skip accountant approval**: on submit they are auto-approved (audit `auto_approved`) and pushed to Zoho immediately. Eligibility = all Zoho-required info present (entity, expense account, payment method with paid-through, amount, merchant, receipt, no open requests).
- Event expenses (Trade Show app, any ext-API source) and incomplete daily expenses still go to the accountant queue as before.
- Failed auto-pushes land in `zoho_sync_failed` for accountant retry. Reimbursable (personal-card) expenses auto-push too but stay in the Reimbursement lane until paid.
- Refactor: shared `lib/zohoPush.ts` used by both accountant push and auto-push.

## 0.5.1-alpha (2026-08-06)

### SSO
- **Fixed**: Authentik login no longer overwrites the user's Midas role on every login. Midas is the source of truth for roles (Admin → Users); Authentik groups only gate app access and set the initial role for auto-created users. Previously, roles assigned in Midas (e.g. developer/partner) were silently reset to the Authentik group mapping at next SSO login.

## 0.5.0-alpha (2026-08-06)

### Admin user management
- **Hard delete users**: instant for users with no data; users owning data get a 409 with per-type counts, and the UI offers an explicit **purge** (removes their expenses + receipt files, messages, captures, partner expenses). Zoho-synced expenses block purge (`ZOHO_LINKED`). Guards: no self-delete, never the last active admin. All deletions audit-logged (`admin.user.deleted` / `admin.user.purged`).
- **Role assignment**: role is editable per user (all five roles incl. partner/developer) from Admin → Users; API blocks self-role-change and demoting the last active admin.

## 0.4.0-alpha (2026-08-06)

### Partner Expenses (new)
- New **partner** role with a standalone partner expense tracker (`/partner-expenses`): shared table of User · Amount · Item/Location · Category, plus a simple intake form (Business/Personal, defaults Business). Fully decoupled from the normal expense flow — no receipts, review queue, reimbursement, or Zoho.
- New **developer** role: all-access, passes every role gate (API `requireRole` + web `ProtectedRoute`/nav).
- New `partner_expenses` table + `partner_expense_category` enum (migrations `0008`, `0009`); audit-logged creates.
- Seed users: `partner@midas.local` / `partner123`, `developer@midas.local` / `developer123`.

## 0.3.9-alpha (2026-08-03)

### Zoho expense accounts (daily expenses)
- New Expense: pick **brand/entity** first, then **expense account** from live Zoho COA (`GET /zoho/expense-accounts?zohoEntity=`).
- Stores `zoho_expense_account_id` / `name` on the expense — no local category maintenance for daily use.
- Trade Show can still use Midas `categoryId` + static `zoho_account_id` maps.

## 0.3.8-alpha (2026-08-03)

### Zoho
- **Fixed** Integration Service auth: send `Authorization: Bearer <ZOHO_SERVICE_TOKEN>` (not `X-Internal-Token`). Wrong header caused `401 ZOHO_AUTH_INVALID` before Zoho OAuth. Live `organizations/list` / COA confirmed with Bearer.
- Live create_books: send `account_id` + `paid_through_account_id`; parse nested `data.expense.expense_id`; strip nested `source` (Zoho Books field, 100-char limit).
- Categories: `zoho_account_id` + Haute Brands COA seed; Personal card → Employee Reimbursements paid-through.
- CT 3120: `ZOHO_MODE=service`, `ZOHO_DRY_RUN=false`. Smoke push succeeded (PORT of SD → Zoho expense id recorded).

## 0.3.7-alpha (2026-08-03)

### Zoho
- Accountant push sends full `buildZohoServicePayload`; service-health probes Zoho auth; queue button labels follow live/mock/dry-run/blocked.

## 0.3.6-alpha (2026-08-03)

### Accountant
- Removed **Claim / Release** (single-accountant workflow). Approve/Reject/Needs review work on pending directly.
- User reply / resolve-request returns expenses to `pending` (not `in_review`). Existing `in_review` rows migrated to `pending`.

## 0.3.5-alpha (2026-08-03)

### Accountant workflow / statuses
- Approval labels: **Pending approval**, **Approved**, **Rejected**, **Needs further review** (maps `pending`/`in_review` / `approved` / `rejected` / `awaiting_info`).
- Zoho shown separately: **Not pushed** | **Pushed** (`ZohoPushBadge`) — not mixed into approval status.
- Review Queue: **Approve / Reject / Needs review** available on pending expenses (no mandatory “Mark as Reviewing” first). Optional Claim/Release kept.
- Quick-view modal: accountant approve/reject/needs-further-review + reimbursement dropdown.

### Reimbursement (personal cards)
- `payment_methods.requires_reimbursement`; Personal (Need reimbursement) flagged.
- Auto-set `reimbursement_status=pending` when personal card is used; backfill existing personal-card rows.
- Reimbursement labels: Needs reimbursement → Approved (pending payment) → Paid.

## 0.3.4-alpha (2026-08-03)

### Payment methods (Trade Show parity)
- Synced all **12** Trade Show `cardOptions` into Midas `payment_methods` (label, last4, entity, Zoho paid-through id).
- New column `payment_methods.default_zoho_entity`; UI Admin Payment Methods shows Entity.
- Backfilled `payment_method_id` (+ `zohoEntity` when blank) on migrated `trade_show` expenses via `cardUsed` last-4.
- Ext: `GET /api/v1/ext/payment-methods` (`expenses:read`). Handoff: `docs/TRADE_SHOW_PAYMENT_METHODS.md`.

## 0.3.3-alpha (2026-08-03)

### UI
- **Receipt quick view**: paperclip pill opens a Trade Show–style modal with **inline receipt image/PDF** (not a navigate-away detail page). Also used on Accountant Queue.
- **Expense detail**: receipt files render inline; **Delete** available when permitted.
- **My Expenses**: row checkboxes, bulk delete, source-app filter (e.g. `trade_show`) for cleaning test imports.

### API
- `GET /expenses/:expenseId/receipts/:receiptId/content` — session-auth receipt stream for UI preview.
- Expanded `DELETE /expenses/:id` — owner draft/unreviewed pending; accountant/admin any without Zoho; admin `?force=true` for Zoho-linked.
- `POST /expenses/bulk-delete` — `{ ids, force? }` with per-id results.

## 0.3.2-alpha (2026-08-03)

### UI
- **My Expenses**: status tabs (All / Needs reply / Under review / Approved / Rejected / Drafts), search, month + category filters, and 10-per-page pagination (Trade Show–style).

## 0.3.1-alpha (2026-08-03)

### UI
- Expense tables (**My Expenses**, **Accountant Queue**): Trade Show–style paperclip **Receipt** pill (`N receipt` / `No receipt`) linking to expense detail `#receipts`.

## 0.3.0-alpha (2026-08-03)

### Ext API — Trade Show Expense Engine
- Full `/api/v1/ext/*` surface: OCR process, expenses CRUD/list/by-ref, receipts (+ content), categories, bulk import with `skipOcr` / Zoho ids / timestamps / idempotent re-import.
- Scope enforcement (`requireScope` → `MISSING_SCOPE`), `source_context` / `externalUserId`, reimbursement `rejected`, Trade Show category seed + mappings.
- Packages: `@midas/ocr-client`, `@midas/import`; migration SQL `0002_ext_trade_show_merge.sql`.
- Sandbox: CT 3120 Ext live; Trade Show CT 2600 migrated **375** expenses zero-loss (M3/M8 closed).

### OCR
- Invalid/tiny PDFs return **`400 OCR_INVALID_FILE`** (not `500 INTERNAL_ERROR`); upstream OCR failures map to `OCR_*` 502/503/504.
- Ext OCR echoes `X-Request-Id` / `requestId` for BFF correlation.
- ImageMagick prep prefers `magick` over legacy `convert`.

### Zoho / expenses UX
- Accountant **Zoho readiness** panel (read-only evaluation; no live Zoho write).
- New expense flow requires receipt capture (stacked from 0.2 line).

### Docs / ops
- Dual-app contract lock, migration reply/apply-go, OCR invalid-fix handoff, Authentik/Zoho/import docs.

## 0.2.0-alpha (2026-06-30)

### Intermediate line (pre-Ext merge)
- Version string advanced for Zoho readiness / receipt-required work; package.json versions were partially updated to `0.2.0` without a full changelog. Superseded by **0.3.0-alpha**, which is the first consistent cut including Ext + migration.

## 0.1.5-alpha (2026-06-25)

### UX clarity (copy/badges only — no behavior change)
- **Dashboard status labels deduped**: removed the duplicate `USER_STATUS_LABEL` map in `Dashboard.tsx` and now import the single source of truth `USER_LABELS` from `StatusBadge.tsx` (fixes "In review"/"Under review" drift; employee-facing labels stay plain-language).
- **Admin user source badge**: `/admin/users` now returns safe booleans `hasPassword` / `hasSso` (derived; the password hash and SSO subject IDs are NOT exposed), and the Admin Users table shows an **"SSO-only / Local / SSO + Local"** badge so admins know how each user signs in (and that a password reset on an SSO-only user creates a local credential).
- **Softer employee-facing OCR wording**: employees now see "Receipt scan complete / in progress / needs review / pending" instead of `OCR: <status>`. Accountant/admin keep the technical `OCR: <status>` + provider/confidence/error detail (unchanged, still role-gated). No OCR mode/behavior change.
- No Zoho/OCR/auth/schema changes. Zoho remains `mock` + dry-run; OCR remains `mock`.

## 0.1.4-alpha (2026-06-24)

### Zoho — integration-service prep (still mock/dry-run; NO live writes)
- **Fixed** `ServiceZohoAdapter` auth: the integration service (v1.28.0) authenticates apps with the **`X-Internal-Token`** header, not `Authorization: Bearer`. The previous Bearer header would have failed app auth on the first service-mode attempt. Brand scoping (`X-Brand`) unchanged.
- Added request **timeouts** (AbortController) to all service calls and hardened error handling so the app token is **never** included in logs or thrown errors.
- Added `checkServiceHealth()` client probe + read-only **`GET /api/v1/zoho/service-health`** (accountant/admin) — reports service reachability/version and current `zohoMode`/`dryRun`/`liveWritesEnabled`. Safe in any mode (only hits the service's public `/health`; never touches Zoho).
- Added `buildZohoServicePayload()` — a **generic, event-agnostic** proposed payload (no `event_id`, works for any `source_app`): idempotency key (`midas-expense-<id>`), category/payment-method with proposed-account placeholders, reimbursable flag, submitter, brand, receipt count, and `source.{app,type,id,url,label}`. Surfaced as `servicePayload` in the readiness response (preview only).
- Tests: client uses `X-Internal-Token` (not Bearer), token redaction on failure, health parse/unreachable handling, payload mapping + idempotency, mock-mode makes no service call.
- **Discovered blocker:** the integration service is **not currently authorized against Zoho** — every Zoho data endpoint returns `ZOHO_AUTH_INVALID`. Live/dry-run-against-real-Zoho cannot proceed until the service team establishes the Zoho OAuth connection for the `haute_brands` org. Midas remains in local readiness-only mode; no dry-run validation endpoint was wired (its contract is not exposed to the Midas app). See `docs/ZOHO_INTEGRATION.md`.

## 0.1.3-alpha (2026-06-24)

### Auth / SSO — fix: Authentik SSO restored
- **Fixed** `unexpected "iss" claim value` token-exchange failure that blocked all Authentik SSO logins.
- Root cause: the Authentik provider advertises a **global/root issuer** (`https://auth.booute.duckdns.org/`) in its discovery document and ID tokens, but Midas was validating the `iss` claim against the per-application env value `AUTHENTIK_ISSUER_URL` (`.../application/o/midas/`).
- `validateIdToken` now validates `iss` against **`discovery.issuer`** (the IdP's authoritative, signed-metadata issuer) instead of the hand-configured env value. Midas is now immune to Authentik issuer-mode drift (global vs. per-application).
- `AUTHENTIK_ISSUER_URL` is retained as a discovery-URL fallback only; it is no longer used for `iss` validation.
- Group-to-role mapping, auto-provisioning, break-glass, and CORS/cookie behavior unchanged.
- Added `validateIdToken` regression tests: accepts tokens matching the discovery issuer (even when the env `issuerUrl` differs), rejects forged issuers, and rejects nonce mismatches.

---

## 0.1.2-alpha (2026-05-21)

### Auth / SSO
- Authentik group-to-role mapping now accepts **both** suite-standard (`app-midas-*`) and legacy (`midas-*`) group names simultaneously
- `AUTHENTIK_GROUP_ADMIN`, `AUTHENTIK_GROUP_ACCOUNTANT`, `AUTHENTIK_GROUP_USER` now accept comma-separated lists; defaults cover both naming schemes
- Precedence unchanged: admin > accountant > user; any approved group in either scheme grants access
- No Authentik group changes required — both naming schemes work until migration is complete

### Testing
- `oidcAuth.test.ts` updated: `mapGroupsToRole` now tests both `app-midas-*` and `midas-*` groups, cross-scheme precedence, mixed-group scenarios, and custom array overrides

---

## 0.1.1-alpha (2026-05-21)

### Integration
- Zoho Integration Service onboarding groundwork (dry-run/safe mode only)
- Midas app identity registered on Zoho Integration Service (CT 9503); credential wired to CT 3120
- `ZOHO_SERVICE_BASE_URL`, `ZOHO_DEFAULT_BRAND`, `ZOHO_DRY_RUN` env vars added
- `ServiceZohoAdapter` corrected: proper auth headers, correct route (`/zoho/expenses/create_books`), dry-run gate
- Zoho readiness model: `evaluateZohoReadiness()` evaluates all 11 required fields server-side
- New API endpoint: `GET /api/v1/expenses/:id/zoho-readiness` (accountant/admin only, read-only)
- Zoho readiness panel in expense detail calls server-side evaluation; shows checklist, missing fields, payload preview
- No live Zoho writes. `ZOHO_MODE=mock` and `ZOHO_DRY_RUN=true` are enforced defaults

### Auth / SSO
- Authentik OIDC SSO enabled and validated on CT 3120
- Auto-provisioning via `AUTHENTIK_AUTO_CREATE_USERS=true`: users auto-created on first SSO login when in an approved Midas group
- SSO-only users have `passwordHash=null`; local login guard blocks them from the password endpoint
- Audit events: `sso.login_success`, `sso.user_auto_created`, `sso.user_linked_by_email`, `sso.login_denied_*`
- Local break-glass login remains (`ALLOW_LOCAL_BREAK_GLASS=true`)

### Branding
- Midas SVG logo added (`/logo.svg`, `MidasLogo` React component)
- Logo in: browser favicon, web manifest, login page, sidebar header
- No external CDN or font dependency

### Infrastructure
- `ZOHO_SERVICE_TOKEN` deployed to CT 3120 via secure Proxmox-mediated handoff (no token printed)
- `ZOHO_MODE=mock` default enforced; dry-run gate guards `ServiceZohoAdapter`

### Testing
- 127 API unit tests pass
- New: `zohoReadiness.test.ts` — 18 tests covering ready state, missing fields, warnings, payload mapping, version string

### Docs
- `docs/ZOHO_INTEGRATION.md` added (integration contract, safety model, activation path)
- `docs/VERSIONING.md`, `docs/OPERATIONS.md`, `docs/API_CONTRACTS.md` updated
- `docs/CHANGELOG.md` created

---

## 0.1.0-alpha (2026-05-08)

Initial Midas scaffold deployed to Proxmox CT 3120.

- Expense CRUD, accountant review queue, receipt uploads, OCR mock
- Zoho mock adapter (no live writes)
- In-app conversation, audit logs
- Browser extension captures
- Admin user management, payment methods
- Authentik OIDC integration scaffolded (enabled in 0.1.1-alpha)
- Postgres on CT 3220, Docker Compose deployment
