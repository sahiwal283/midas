# Midas Pilot Checklist

Operator walkthrough for first-use verification. Run top-to-bottom, one step at a time.
Complete all steps before calling the pilot live.

**Infrastructure:** CT 3120 (192.168.1.210) — API + Web  
**DB:** CT 3220 (192.168.1.211) — PostgreSQL 15  
**Web URL:** http://192.168.1.210:5173  
**API URL:** http://192.168.1.210:4000

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
- [ ] Admin credentials available — the admin password is in `/opt/midas/.env` on CT 3120:
  ```bash
  ssh root@192.168.1.190 "pct exec 3120 -- grep ADMIN /opt/midas/.env"
  ```
  If needed, reset the admin password:
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

- [ ] Open `http://192.168.1.210:5173` in browser
- [ ] Log in as `admin@midas.local` with the admin password
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
- [ ] Receipt appears in the list with filename and "OCR: pending [mock]"
- [ ] Log out as employee

---

## 7. Accountant review — claim and approve

Log in as the accountant.

- [ ] Accountant Workspace → "Needs Review" lane shows the submitted expense
- [ ] Click "Mark as Reviewing" on the expense — expense moves to "In Review" lane
- [ ] Open the expense detail (click merchant name)
- [ ] Verify: receipt visible, description correct, amount/date/category/payment method shown
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

Run from CT 3120 (replace `<admin_password>` with the actual admin password):

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c '
  API_URL=http://localhost:4000 WEB_URL=http://localhost:5173 \
    ADMIN_EMAIL=admin@midas.local ADMIN_PASS=<admin_password> \
    bash /opt/midas/scripts/smoke-test.sh
'"
```

- [ ] All smoke test checks pass

---

## 13. Workflow verification

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash /opt/midas/scripts/verify-workflows.sh"
```

- [ ] All checks pass (script self-cleans: rejects test expenses, deactivates test user and payment method)

---

## Pilot go / no-go

All boxes checked → pilot is ready.

If any box is unchecked, resolve before proceeding. Refer to `docs/OPERATIONS.md` for
troubleshooting steps.

---

## Deferred until after pilot

The following are known limitations that do not block the pilot:

- Zoho is in mock mode — no real pushes to Zoho
- OCR is in mock mode — no real receipt text extraction
- Authentik SSO not wired — all users use local bcrypt passwords
- Argo integration not active — no cross-app expense submission
- Offsite backup not configured — daily backup cron runs at 02:00 and stores to `/opt/midas/backups/` (local only, 14-day retention). See `docs/BACKUP_RESTORE.md` for offsite options.
