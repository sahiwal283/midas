# Midas — Project Docket

_Last updated: 2026-06-25 • Version: **0.1.5-alpha**_

## ✅ Closeout — ready for tiny internal pilot (2026-06-25)

**Midas v0.1.5-alpha is ready for a tiny internal pilot.** All Midas-side pilot work is complete and verified; **no active Midas-side coding tasks remain.** Everything still open is blocked on an external decision (Zoho Integration Service, accounting, or an offsite/DR destination) or deferred by operator approval.

| Area | State |
|------|-------|
| Tiny-pilot readiness | **Ready** |
| Operator browser walkthrough | **Skipped by operator** (API/server workflow verified instead) |
| SSO (Authentik) | ✅ Works |
| Local break-glass login | ✅ Works |
| Pilot users (accountant + employee) | ✅ Exist, active |
| Active payment method | ✅ Exists (Corporate Amex) |
| `verify-workflows.sh` | ✅ Passed (53/53) |
| Primary backup | ✅ Works (daily 02:00, integrity-valid) |
| Secondary backup | ✅ Works (fixed 2026-06-25, integrity-valid) |
| Restore validation drill | ✅ Passes (temp-DB restore on CT 3220) |
| Core UX clarity sweep + B-polish | ✅ Complete |
| OCR | Remains **mock** — deferred (operator approval) |
| Zoho (Midas side) | **mock / dry-run**; Midas-side prep **complete** |
| Live Zoho writes | **Blocked** — Zoho Integration Service (`ZOHO_AUTH_INVALID` + hidden validate contract) + accounting mapping decisions |
| Offsite / DR backup | **Blocked** — awaiting external destination decision |
| Active Midas-side coding tasks | **None** |

## Current state (verified)

| Item | Status |
|------|--------|
| URL | https://midas.booute.duckdns.org (HTTPS via NPM; not the LAN IP) |
| Runtime | CT 3120 @ 192.168.1.210 • DB CT 3220 @ 192.168.1.211 |
| Version | 0.1.5-alpha (`/api/v1/meta`) |
| Auth | `AUTH_MODE=authentik` — SSO **works**; local break-glass **works** |
| Pilot accounts | `pilot.accountant@midas.local` (accountant), `pilot.employee1@midas.local` (user) — active |
| Payment method | "Corporate Amex" active (company-wide) |
| API workflow | ✅ submit→review→request-info→reply→approve verified end-to-end |
| `verify-workflows.sh` | ✅ **53/53 checks pass** (2026-06-24) — incl. audit trail, role separation, release-claim, user mgmt |
| Smoke test | ✅ 8/8 |
| OCR | `OCR_MODE=mock` — no real calls |
| Zoho | `ZOHO_MODE=mock`, `ZOHO_DRY_RUN=true` — **no live writes**; service path prepared but blocked service-side |
| Backups | Daily 02:00 (CT 3120 `/opt/midas/backups`); latest verified gzip/tar integrity PASS |
| Capacity | local-lvm **69%**, CT 3120 rootfs 52%, CT 3220 5% — not a blocker |
| Postgres exposure | CT 3120 does **not** expose 5432 |

---

## A. Immediate tiny-pilot readiness

- [x] SSO + break-glass login working
- [x] Pilot accountant + employee exist and active
- [x] Active payment method exists
- [x] API workflow verified end-to-end
- [x] `verify-workflows.sh` 53/53 pass
- [x] Smoke test 8/8
- [x] Daily backup job running; latest backup integrity-valid
- [x] **Operator browser walkthrough of `PILOT_CHECKLIST.md` §1–§11 — skipped by operator** (decision accepted). Server/API equivalents all pass (`verify-workflows.sh` 53/53), so the tiny pilot is considered **ready**.

## B. Core UX clarity sweep before broader rollout
- [x] **Clarity sweep completed (2026-06-25) — surfaces pass, no code changes needed.** Inspected admin user mgmt, audit trail, employee dashboard/list, accountant queue/detail. Verified: sensitive data hidden (`/admin/users` excludes `passwordHash`; `internalNote`/OCR provider/confidence/error + audit trail + Zoho panel all gated to accountant/admin; employees use plain-language `StatusBadge variant="user"` + `StatusBanner`); mock/dry-run clearly labeled (`Push to Zoho [mock]`, lanes state "no real sync"); role separation enforced (employee→accountant 403, accountant→admin 403); temp-password shown-once flow clear; self-deactivate guarded. Result: clear + safe for tiny pilot.
- [x] **Polish batch done (2026-06-25, v0.1.5-alpha):** (1) deduped `Dashboard.tsx` status labels → import shared `USER_LABELS` from `StatusBadge`; (2) Admin "SSO-only / Local / SSO + Local" badge backed by safe `hasPassword`/`hasSso` booleans from `/admin/users` (no passwordHash/subject IDs exposed); (3) employee-facing receipt labels now "Receipt scan complete/in progress/needs review/pending" (accountant/admin keep technical `OCR: <status>`). Copy/badges only — no Zoho/OCR/auth/schema change. _Deploy note: rebuilding web exposed that the prod nginx web must be built with `docker-compose.prod.yml` only (see OPERATIONS.md) — a brief web outage during this deploy was recovered._
- Surface Zoho dry-run result / integration request id / last-validation time in the readiness panel — deferred until the service dry-run path is enabled (no data to show yet).
- Reimbursement: today status-tracking only; full reimbursement workflow is post-pilot.

## C. Zoho Integration Service track — **BLOCKED on service-side work** (do not code further in Midas)
- Midas side is ready: `X-Internal-Token` auth, `X-Brand`, `checkServiceHealth()`, `GET /api/v1/zoho/service-health`, generic `servicePayload` (idempotency key + `source_*`), readiness model. No live writes.
- Blocked on the integration-service team:
  1. **`ZOHO_AUTH_INVALID`** — service not authorized against Zoho for `haute_brands` (Zoho OAuth connection).
  2. `/zoho/expenses/validate` contract not exposed to Midas.
  3. `/openapi.json` / capabilities not accessible to the Midas app.
- After those: accounting sign-off (group G) + operator flips `ZOHO_MODE=service`/`ZOHO_DRY_RUN=false` + rebuild.

## D. OCR track (deferred)
- `OCR_MODE=mock`. Service adapter exists; Stage-3 single real call was done 2026-05-14 ($0.10). Switching to service mode needs explicit operator approval. Not for pilot.

## E. Cross-app / Argo / browser extension track (deferred)
- `/api/v1/ext/*` app-to-app API + admin API-key UI exist but unexercised (no Argo caller).
- Browser extension: out of scope per operator.

## F. Ops / backup / production readiness
- [x] Primary daily backup (DB + uploads) on CT 3120, integrity-valid (cron `0 2 * * *`, 14-day retention).
- [x] **Secondary copy FIXED (2026-06-25)**: was silently no-op'ing since ~2026-05-15 due to cron `PATH` excluding `/usr/sbin` (`pct` not found). Fixed PATH in script + `/etc/cron.d/midas-backup-secondary`; script now exits nonzero on 0-file sync (no phantom success). Verified 33 files synced; newest secondary matches primary; integrity PASS.
- [x] **Restore validation drill added + passing (2026-06-25)**: `/root/scripts/midas-validate-restore.sh` (host-side) restores the latest dump into a temp DB on CT 3220 as local `postgres`, sanity-checks (10 tables / 30 users / 55 expenses), and drops it. Prod untouched. Repo copy: `scripts/validate-restore.sh`.
- [ ] **True offsite/DR still pending**: primary + secondary are both on the same physical host. Requires a remote/NAS destination (rsync/rclone). _Production gate, not a pilot blocker._

## G. Blocked on operator / accounting / service decisions
- Accounting sign-off of `ZOHO_MAPPING_REVIEW.md` §5/§6 + decisions A–J (category→COA, payment-method→paid-through, reimbursable vs company-card, idempotency confirmation).
- Operator approval to enable OCR service mode / live Zoho writes.

## H. Explicitly deferred
- Logo/UI aesthetic polish.
- Live Zoho writes; real OCR extraction; browser extension; reimbursement automation; multi-replica/queue-based Zoho push.
