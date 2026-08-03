# Midas Pilot Checklist

Operator walkthrough for first-use verification. Run top-to-bottom, one step at a time.
Complete all steps before calling the pilot live.

**Infrastructure:** CT 3120 (192.168.1.210) — API + Web  
**DB:** CT 3220 (192.168.1.211) — PostgreSQL 15  
**Web URL:** https://midas.booute.duckdns.org (canonical, HTTPS via NPM proxy)  
**API URL:** https://midas.booute.duckdns.org/api/v1  
**Note:** Access Midas via the HTTPS domain, not the old LAN URL `http://192.168.1.210:5173`. With `COOKIE_SECURE=true` and `CORS_ORIGIN=https://midas.booute.duckdns.org`, SSO/session cookies only set over the HTTPS domain.

> **Automated-gate status (2026-06-24, v0.1.4-alpha):**
> - §12 Smoke test — ✅ **8/8 pass**
> - §13 Workflow verification (`verify-workflows.sh`) — ✅ **53/53 pass** (full review loop, request-info, resolve-request, queue flags, audit trail + role gating, admin user mgmt, release-claim ownership; self-cleaned)
> - §14 Backup — ✅ daily 02:00 primary + 02:15 secondary (ssd2) **both working** (secondary cron-PATH bug fixed 2026-06-25); latest DB/uploads **integrity-valid**; **restore-to-temp-DB drill passes** (`/root/scripts/midas-validate-restore.sh`). Offsite/DR (different host) still pending — production gate, not pilot.
> - SSO + local break-glass — ✅ working. OCR mock / Zoho mock+dry-run — ✅ no live calls.
> - **Remaining for go-live:** the human **browser** walkthrough of §1–§11 below (server/API equivalents all pass).

---

## 0. Pre-flight

- [ ] CT 3220 is running (`pct status 3220` → running)
- [ ] CT 3120 is running (`pct status 3120` → running)
- [ ] API health check passes:
  ```bash
  ssh root@192.168.1.190 "pct exec 3120 -- curl -s http://localhost:4000/api/v1/health"
  # Expected: {"status":"ok","db":"ok"}
  ```
- [ ] Web is reachable from browser: `http://192.168.1.210:5173` → loads Midas login page
- [ ] Admin credentials available — the admin password is NOT stored in `.env` (it is a seeded bcrypt hash). Use the reset script to set a known password:
  ```bash
  ssh root@192.168.1.190 "pct exec 3120 -- docker exec midas-api-1 sh -c 'ADMIN_PASSWORD=NewPass123 npx tsx src/scripts/reset-admin-pw.ts'"
  ```
- [ ] Run test-data cleanup to keep the queue clean after verify-workflows.sh runs.
  Get the DB password first:
  ```bash
  ssh root@192.168.1.190 "pct exec 3120 -- grep POSTGRES_PASSWORD /opt/midas/.env"
  ```
  Then run the cleanup (replace `<db_password>` with the value above):
  ```bash
  ssh root@192.168.1.190 "pct exec 3220 -- env PGPASSWORD=<db_password> psql -h 127.0.0.1 -U midas midas -c \"UPDATE expenses SET status='rejected', updated_at=NOW() WHERE merchant IN ('Ownership Test Co','Workflow Test Co') AND status!='rejected';\""
  ```

---

## 1. Admin login

**Auth mode:** `AUTH_MODE=authentik` with `ALLOW_LOCAL_BREAK_GLASS=true`. Login page shows both "Sign in with Authentik" and the local email/password form.

- [ ] Open `http://192.168.1.210:5173` in browser — login page shows "Sign in with Authentik" button
- [ ] Check: `curl -s http://192.168.1.210:4000/api/v1/auth/config` → `{"authMode":"authentik","showLocalLogin":true}`
- [ ] Log in via **break-glass** (email/password form) as `admin@midas.local` with the admin password
  - OR log in via Authentik SSO (requires `midas-admins` group membership in Authentik)
- [ ] Lands on dashboard — no error banner, no redirect loop
- [ ] Top nav shows: Dashboard, My Expenses, Admin

---

## 2. Create payment methods (required before employees submit expenses)

Go to **Admin → Payment Methods** in the sidebar.

- [ ] At least one payment method exists (e.g. "Corporate Amex ···1234")
- [ ] If none exist: click "Add Method", fill in Label and optional Last 4 digits, check "Visible to all employees", click Add
- [ ] Payment method appears in list as Active

---

## 3. Create pilot users

Go to **Admin → Settings → Users tab**.

- [ ] Create accountant user: name, email, role=Accountant, password
  - Note the temporary password displayed after creation — copy it, it is shown once
- [ ] Create at least one regular user: name, email, role=User, password
  - Note the temporary password
- [ ] User table shows all three accounts as Active
- [ ] Log out as admin

---

## 4. Accountant login

- [ ] Log in as the accountant user created above
- [ ] Lands on Accountant Workspace
- [ ] Queue lanes may show prior setup data — all pilot test items should have been cleared in step 0
- [ ] Log out as accountant

---

## 5. Employee expense submission

Log in as the regular user created above.

- [ ] Dashboard loads with "Welcome, [name]"
- [ ] "New Expense" button visible
- [ ] Click New Expense → fill in: merchant, amount, date, category, payment method, description
- [ ] Submit creates the expense as draft
- [ ] Click "Submit for Review" on the expense detail page
- [ ] Expense status changes to "Submitted — waiting for review"
- [ ] Dashboard shows expense in Recent Expenses with status "Submitted — waiting for review"
- [ ] My Expenses list shows the expense
- [ ] Log out as employee

---

## 6. Receipt upload

Log in as the same employee.

- [ ] Open the submitted expense
- [ ] Click Upload in the Receipts section
- [ ] Upload a JPEG or PDF file under 10 MB
- [ ] Receipt appears in the list with filename and "OCR: pending" (status cycles to "done" within ~5 seconds)
- [ ] Note: OCR runs in **mock mode** during pilot — no real calls to CT 9500, no cost
- [ ] Log out as employee

---

## 7. Accountant review — claim and approve

Log in as the accountant.

- [ ] Accountant Workspace → "Needs Review" lane shows the submitted expense
- [ ] Click "Mark as Reviewing" on the expense — expense moves to "In Review" lane
- [ ] Open the expense detail (click merchant name)
- [ ] Verify: receipt visible, description correct, amount/date/category/payment method shown
- [ ] If the receipt has an OCR needs-review flag: amber "OCR: needs review" badge appears in the queue flags column; OCR panel visible in expense detail (accountant-only)
- [ ] Zoho Readiness panel shows what is complete and what is missing
- [ ] Recent Activity sidebar shows: "Created via…", "Submitted for review"
- [ ] Return to queue — use "Approve" button
- [ ] Expense disappears from "Needs Review" and "In Review" lanes
- [ ] Log out as accountant

---

## 8. Employee sees approval

Log in as the employee.

- [ ] Dashboard shows expense with "Approved" status
- [ ] Expense detail shows "Approved" banner
- [ ] No "Action needed" callout visible
- [ ] Log out

---

## 9. Request info flow

Submit a second expense as the employee (leave out a field, e.g. no category).

- [ ] Log in as accountant
- [ ] Claim the expense
- [ ] Use "Ask" button — select "General question", type a message, click Send
- [ ] Expense moves to "Awaiting User" lane
- [ ] Log out as accountant

- [ ] Log in as employee
- [ ] Dashboard shows amber "Action needed" callout with the expense listed
- [ ] Expense list row is highlighted amber with "Reply to accountant" link
- [ ] Open the expense detail — "Action needed" banner at top, amber message box visible
- [ ] Reply in the conversation input (amber-bordered field)
- [ ] Log out as employee

- [ ] Log in as accountant
- [ ] Expense is back in "In Review" lane (employee reply auto-transitions it)
- [ ] Open the expense — "Mark all resolved" button visible on conversation panel
- [ ] Click "Mark all resolved"
- [ ] Expense stays in a reviewable state
- [ ] Approve the expense
- [ ] Log out as accountant

---

## 10. Reimbursement tracking

Log in as accountant on an approved expense.

- [ ] Open an approved expense
- [ ] Verify reimbursement status shows (e.g. "Not Requested")

---

## 11. Admin user management

Log in as admin.

- [ ] Deactivate the regular user account — status changes to "Inactive"
- [ ] Log out as admin
- [ ] Log in as the deactivated user — should get "Invalid email or password" (intentionally vague — does not reveal account state)
- [ ] Log in as admin again
- [ ] Reactivate the user — status changes to "Active"
- [ ] Reset password for the user — temp password appears in yellow row, "shown once" notice
- [ ] Dismiss the yellow row — it disappears
- [ ] Admin cannot deactivate their own account — Deactivate button is disabled for the logged-in admin

---

## 12. Smoke test (automated)

Run from CT 3120 (credentials sourced from `.env.test`):

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c '
  set -a && source /opt/midas/scripts/.env.test && set +a
  API_URL=http://localhost:4000 WEB_URL=http://localhost:5173 \
    bash /opt/midas/scripts/smoke-test.sh
'"
```

Or pass the password inline:
```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c '
  API_URL=http://localhost:4000 WEB_URL=http://localhost:5173 \
    MIDAS_TEST_ADMIN_PASSWORD=<admin_password> \
    bash /opt/midas/scripts/smoke-test.sh
'"
```

- [ ] All smoke test checks pass

---

## 13. Workflow verification

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c '
  set -a && source /opt/midas/scripts/.env.test && set +a
  bash /opt/midas/scripts/verify-workflows.sh
'"
```

- [ ] All checks pass (script self-cleans: rejects test expenses, deactivates test user and payment method)

---

## 14. Backup validation

```bash
# Validate latest DB backup
pct exec 3120 -- bash -c 'LATEST=$(ls -t /opt/midas/backups/db_*.sql.gz | head -1) && gzip -t "$LATEST" && echo "PASS: $LATEST"'
# Validate latest uploads backup
pct exec 3120 -- bash -c 'LATEST=$(ls -t /opt/midas/backups/uploads_*.tar.gz | head -1) && tar -tzf "$LATEST" >/dev/null && echo "PASS: $LATEST"'
# Verify secondary copy is current
ls -lh /mnt/ssd2/midas-backups/ | tail -5
```

- [ ] DB backup gzip validation passes
- [ ] Uploads backup tar validation passes
- [ ] Secondary copy on ssd2 contains today's backup files

---

## Pilot go / no-go

> **✅ Tiny internal pilot: READY (2026-06-25, v0.1.5-alpha).**
> **Operator browser walkthrough skipped; API/server workflow verified.** The §1–§11 browser
> steps were not run by choice of the operator; their server/API equivalents are all verified —
> `verify-workflows.sh` 53/53, smoke 8/8, SSO + local break-glass working, pilot users + payment
> method present, backups (primary + secondary) healthy, and the restore-validation drill passes.

All boxes checked → pilot is ready.

If any box is unchecked, resolve before proceeding. Refer to `docs/OPERATIONS.md` for
troubleshooting steps.

---

## Deferred until after pilot

The following are known limitations that do not block the pilot:

- Zoho is in mock mode — no real pushes to Zoho
- OCR is in **mock mode** (safe pilot default) — no real calls to CT 9500, no cost per receipt. Stage 3 (one controlled real call) was completed 2026-05-14 at $0.1015. Switching to service mode requires explicit operator approval; see `docs/ocr-integration.md`.
- Authentik SSO is **live and working** (restored 2026-06-24, v0.1.3-alpha) — valid Authentik users in approved Midas groups (`app-midas-*` / `midas-*`) sign in and are auto-provisioned. Local bcrypt login remains as a break-glass fallback (`ALLOW_LOCAL_BREAK_GLASS=true`). Pilot users may use either path.
- Argo integration not active — no cross-app expense submission
- Offsite backup not configured — primary backup runs at 02:00 (CT 3120 `/opt/midas/backups/`); secondary copy runs at 02:15 (Proxmox host ssd2 `/mnt/ssd2/midas-backups/`). Both copies are on the same physical host. Offsite replication required before production. See `docs/BACKUP_RESTORE.md`.
- local-lvm at 93.5% capacity (2026-05-15) — monitor with `pvesm status` before expanding storage or adding CTs.
