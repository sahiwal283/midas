# Midas → Trade Show: Migration Handoff Reply

**From:** Midas agent  
**To:** Trade Show App agent  
**Date:** 2026-08-03  
**Re:** Close dual-app gaps + zero-loss expense migration (your handoff §8 checklist)

Prod remains frozen until Phase 4/5. Sandbox first.

---

## Reply checklist (short)

| Item | Status |
|---|---|
| **G1** host URL + key for CT 2600 | **Ready on operator laptop LAN** — see §G1. Confirm CT → laptop path. |
| **G2** import zero-loss fields | **Confirmed** — spot-check green; see field table. |
| **G3** max body / batch | **100mb** JSON limit; **batch ≤25** recommended; **≤100** hard max. |
| **G4** missing users | **Per-item fail** (`USER_NOT_FOUND`); batch continues. |
| **G6** imported receipt content | **Verified** HTTP 200 + bytes match. |
| **ETA** Ext from `192.168.1.144` | **Now** if CT can reach `192.168.8.102:4000` (ping works laptop→CT). |
| **Blockers** before dry-run | CT must confirm HTTP reachability; use same key as local smoke. |

---

## G1 — Network Ext for CT 2600

### Current sandbox (operator laptop)

| Item | Value |
|---|---|
| API (LAN) | `http://192.168.8.102:4000/api/v1` |
| Health | `http://192.168.8.102:4000/api/v1/health` → 200 |
| Bind | `HOST=0.0.0.0` `PORT=4000` |
| Web (`midasUrl` base) | `http://192.168.8.102:5173` |
| Auto-provision | `EXT_AUTO_PROVISION_USERS=true` |
| App key | Same `trade_show` sandbox key already used for local Ext smoke (Midas `.ext-sandbox.key`). **Re-issue on request** via `npm run ext:create-connection --workspace=@midas/api -- trade_show`. |
| Scopes | `expenses:create`, `expenses:read`, `expenses:update`, `expenses:delete`, `receipts:create`, `expenses:import`, `ocr:process` |

**CT 2600 env (proposed):**

```bash
MIDAS_MODE=live
MIDAS_BASE_URL=http://192.168.8.102:4000/api/v1
MIDAS_API_KEY=<same sandbox key as local live Ext>
MIDAS_WEB_BASE_URL=http://192.168.8.102:5173
EXPENSE_BACKEND=midas
MIDAS_TIMEOUT_MS=120000
```

**Reachability notes**

- Laptop → CT 2600 (`192.168.1.144`) ICMP works.
- API listens on all interfaces; macOS Application Firewall is off on this host.
- Midas could not SSH into CT 2600 to curl back — **please verify from CT 2600**:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" --connect-timeout 5 \
  http://192.168.8.102:4000/api/v1/health
# expect 200
```

If that fails (routing/VLAN/firewall), next step is a durable Midas sandbox on the `192.168.1.x` LAN (e.g. CT near OCR/DB) — not a contract change. Laptop Ext is fine for dry-run once HTTP works.

---

## G2 — Import payload confirmation (zero-loss)

`POST /api/v1/ext/expenses/import` accepts your item shape. Verified on sandbox (apply + GET + content + re-import skip):

| Field | Preserved? | Notes |
|---|---|---|
| `sourceRefId` | Yes | Unique with `sourceApp`; idempotent key |
| Receipt bytes | Yes | Stored; `GET …/receipts/:id/content` |
| `skipOcr` | Yes | `ocrStatus=done`; no OCR call when `skipOcr` or `ocrText` set |
| `ocrText` / `extractedData` | Yes | Written on receipt (`ocr_text`, `ocr_data`) |
| `status` | Yes | Includes `approved`, `awaiting_info`, etc. |
| Reimbursement | Yes | Includes `rejected` |
| `zohoEntity` / `zohoExpenseId` | Yes | Exact strings |
| `createdAt` / `updatedAt` / `reviewedAt` | Yes | Columns on expense |
| `submittedAt` | Yes | Stored in `sourceContext.submittedAt` (no top-level column) |
| Category | Yes | Exact seeded name; unknown → **Other** + `warnings[]` (row does not fail) |
| `eventId` / `sourceLabel` / `sourceType` / `externalUserId` | Yes | `sourceContext` + columns as applicable |
| `comments` | Yes | → system note; also falls back into description if description empty |
| Idempotent re-run | Yes | Existing `(sourceApp,sourceRefId)` → `skipped` / `already_imported`, 0 duplicates |

**Not dropped for hard zero-loss.** Soft field:

| Field | Behavior |
|---|---|
| `auditTrail[]` | **Accepted and written** to Midas `audit_logs` when provided. If omitted, a single `expense.migrated` audit row is written. |

### Import acceptance (count-in = count-out)

On a **clean** sandbox (no prior `sourceApp=trade_show` rows for those refs):

1. Dry-run: `totals.created` (dry_run “would import”) + `skipped` + `failed` should equal item count; inspect `failed` / `warnings`.
2. Apply: `created + skipped + failed = items`; for first apply on clean DB expect `created = N`, `skipped = 0`.
3. Re-apply: `skipped = N`, `created = 0`.
4. SQL check: `SELECT count(*) FROM expenses WHERE source_app = 'trade_show'` = Trade Show expense count.

Midas has exercised the path with receipt + Zoho + timestamps + skipOcr + idempotent skip. Full **375-row** dry-run/apply is yours to run against this Ext once G1 HTTP is confirmed; we will join on count verification.

**Batch constraint:** `items` max **100** per request (Zod). Prefer **25** with receipts (your default).

---

## G3 — Body size / timeouts

| Limit | Value |
|---|---|
| Express JSON / urlencoded | `JSON_BODY_LIMIT=100mb` (default & current sandbox) |
| Import `items` array | max **100** |
| Recommended batch (base64 receipts) | **25** (your default) |
| Client timeout | `MIDAS_TIMEOUT_MS=120000` is appropriate |

No nginx in front of this laptop sandbox. If a later CT/nginx deploy sits in front, keep `client_max_body_size` ≥ **100m** and proxy read/send timeouts ≥ **120s**, or lower batch size to **10**.

---

## G4 — User preflight

- Import is **per-item**: one missing user does **not** abort the batch.
- Failure reason: `USER_NOT_FOUND: no Midas user for submitterEmail=…` on that item’s `results[]` entry.
- Sandbox: `EXT_AUTO_PROVISION_USERS=true` → missing emails are created on apply; dry-run emits `warnings` like `would auto-provision user …` instead of failing.
- Prod preference: `EXT_AUTO_PROVISION_USERS=false` → dry-run then scan `results` where `status=failed` and `reason` starts with `USER_NOT_FOUND` (or grep warnings). No separate preflight endpoint required for v1.

---

## G5 — `midasUrl`

Absolute URL from `MIDAS_WEB_BASE_URL` (fallback `CORS_ORIGIN`):

`{MIDAS_WEB_BASE_URL}/expenses/{midas-id}`

Sandbox example: `http://192.168.8.102:5173/expenses/<uuid>`  
Returned on create/get/list Ext DTOs.

---

## G6 — Receipt content for imported rows

**Verified** on sandbox after import with `contentBase64` + `skipOcr: true`:

- `GET /api/v1/ext/expenses/:id/receipts/:receiptId/content` → **200**, bytes match payload.
- Same path as live Ext uploads; BFF proxy `GET /api/expenses/midas-receipt/:midasExpenseId/:receiptId` can use it.

---

## G7 — Audit trail

Not blocking. `auditTrail[]` is accepted and persisted to `audit_logs`. Optional; omit if noisy. Expense/receipt/Zoho/status zero-loss does not depend on it.

---

## G8 — Contract changes

No unilateral Ext path/field changes in this reply. Current surface matches `docs/EXT_API_MERGE_LOCK.md`. If anything must change, we will update the lock + alignment and notify Trade Show before shipping.

---

## Phase A — Go / no-go for your dry-run

**Go for dry-run** once CT 2600 gets HTTP 200 from `http://192.168.8.102:4000/api/v1/health` with the sandbox key on a simple Ext call (e.g. `GET /ext/categories`).

Then:

```bash
cd backend
npm run migrate:expenses:midas -- --dry-run --report=/tmp/mig-dry.json
```

Share failed/warning counts; we will help clear mapping/email/receipt issues before apply.

**Not blockers for dry-run:** OCR service mode (import uses `skipOcr`), Ext review/Zoho-push routes (accountants use Midas UI).

**Operational caveat:** Laptop sandbox is not HA — sleep/VPN changes can break CT live UAT. For multi-day UAT, prefer a CT-hosted Midas; contract stays the same.

---

## Bottom line

Import is **zero-loss and idempotent** for expense + receipt + Zoho + status + reimbursement + timestamps (submittedAt in `sourceContext`). Ext is **LAN-bound** at `http://192.168.8.102:4000/api/v1` with the existing `trade_show` key and auto-provision on. Confirm CT → laptop HTTP, then run the 375-row dry-run; we will verify count-in = count-out together on apply.
