# Notifications — Design

**Date:** 2026-08-07
**Status:** Approved (roadmap sub-project F)

## Data (migration 0012)

`notifications`: `id uuid PK`, `user_id uuid FK users ON DELETE CASCADE not
null`, `type text not null` ('action_required' | 'approved' | 'rejected' |
'reimbursement_paid'), `title text not null`, `body text`, `expense_id uuid FK
expenses ON DELETE CASCADE`, `read_at timestamp`, `emailed_at timestamp`,
`created_at timestamp default now`.

## Creation hooks (lib/notify.ts)

`notify(userId, type, { title, body, expenseId })` inserts + fire-and-forget
email. Called from:
- accountant `request_info` review → owner: action_required — "Action required:
  expense needs information" / "Your accountant needs additional information
  for your ${amount} expense at {merchant}."
- review approve (single + bulk) → owner: approved — "Expense approved".
  (Auto-approved daily expenses do NOT notify — the submitter watched it
  happen.)
- review reject → owner: rejected — "Expense rejected" + note when present.
- reimbursement status → 'paid' → owner: reimbursement_paid — "Reimbursement
  paid" / "Your ${amount} reimbursement for {merchant} was marked paid."
Never notify the actor about their own action.

## API

`GET /notifications?unread=true&limit=` (caller's own, desc, ≤50 default 20) →
`{ notifications, unreadCount }`; `POST /notifications/:id/read`;
`POST /notifications/read-all`.

## Email

`EMAIL_MODE=off|smtp` (default off) + `SMTP_HOST/PORT/USER/PASS/FROM` env.
New dep `nodemailer` (API rebuild on deploy). `lib/email.ts`
`sendEmail(to, subject, text)` — in `off` mode logs and returns. Notification
emails include a deep link `{webBase}/expenses/{expenseId}`. Failures never
break the calling request (fire-and-forget with catch → log; `emailed_at` set
on success).

## Web

Bell icon with unread badge: desktop sidebar header area + mobile top-right
(next to the More trigger or in the header). Opens a dropdown/sheet: unread
highlighted, each row = title, body, relative time, tap → expense + mark read;
"Mark all read". Poll unreadCount every 60s (react-query refetchInterval).

## Testing

Vitest: notification message builders (pure `lib/notifyMessages.ts`:
`buildNotification(type, { merchant, amount, note? })` → { title, body })
matrix. Email/e2e by env-off logging + visual pass.

## Out of scope

Push notifications, digests, per-user notification preferences, Telegram.
