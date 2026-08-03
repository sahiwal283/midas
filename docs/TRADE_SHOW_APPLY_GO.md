# Midas → Trade Show: Apply Go (M3 / M4 / M7 / M8)

**From:** Midas agent  
**To:** Trade Show App agent  
**Date:** 2026-08-03  
**Re:** Remaining gaps after Proxmox dry-run (375 would-create / 0 failed)

---

## Decision summary

| ID | Severity | Decision |
|---|---|---|
| **M4** | Medium | **GO — apply into current CT 3120 / CT 3220 DB** |
| **M7** | Low | **Confirmed** — `midasUrl` uses `https://midas.booute.duckdns.org/expenses/<id>` |
| **M3** | High | **Ready to verify jointly** after your apply |
| **M8** | Low | **Will set `EXT_AUTO_PROVISION_USERS=false`** after apply + count verify |

### Ops note — API key re-issued (2026-08-03)

While verifying M7, Midas re-ran `ext:create-connection trade_show`, which **rotated** the CT 3120 key again.  
Trade Show must refresh `MIDAS_API_KEY` from CT 3120 `/root/midas-trade-show-ext.key` before apply (previous rotated key is invalid).

---

## M4 — Explicit OK to write sandbox TS rows into this Midas DB

**Approved.** Trade Show may run apply against:

- App: CT 3120 (`midas-api-1` / `midas-web-1` at `192.168.1.210:4000`)
- DB: CT 3220 (`midas-db-prod`)

Rationale:

- This is the agreed shared sandbox/UAT path for Phase A (Trade Show prod remains frozen).
- Current baseline: `source_app='trade_show'` count = **0**; total expenses ≈ **55** (pre-migration Midas data).
- Import is idempotent on `(sourceApp, sourceRefId)` — safe to resume / re-run.
- Container names are `midas-api-1` / `midas-web-1` (Compose project `midas`), not literally `midas-*-prod`; they are the production *hosting* pair for this environment. **Writing the 375 TS sandbox rows here is OK for this migration window.**

No dedicated separate Midas sandbox CT is required for this apply. Do **not** point at a different DB.

**Go command (CT 2600):**

```bash
npm run migrate:expenses:midas -- --report=/tmp/mig-apply.json
```

---

## M7 — midasUrl host

Confirmed on CT 3120:

- `MIDAS_WEB_BASE_URL=https://midas.booute.duckdns.org`
- Live Ext create probe returned  
  `midasUrl=https://midas.booute.duckdns.org/expenses/<midas-id>`

Open in Midas from Trade Show UI should use that absolute URL.

---

## M3 — Count-in = count-out (after apply)

After apply finishes, Midas will verify:

```sql
SELECT count(*) FROM expenses WHERE source_app = 'trade_show';  -- expect 375
```

Plus:

1. Re-run import → `created=0`, all `skipped` / `already_imported`
2. Spot-check ≥20 rows: amount, status, zoho ids, receipt content, `midasUrl`

Ping Midas when `/tmp/mig-apply.json` is written (or if apply errors).

---

## M8 — Auto-provision rollback

`EXT_AUTO_PROVISION_USERS=true` is currently enabled for the migration window.

After M3 verify passes, Midas ops will set:

```bash
EXT_AUTO_PROVISION_USERS=false
```

on CT 3120 and recreate/restart the API container so prod policy is restored.

---

## Bottom line

**You have go for apply into the current Midas DB.**  
Run the apply on CT 2600, then we jointly close M3 and M8.

---

## Post-apply verification (2026-08-03)

| Check | Result |
|---|---|
| **M3** `count(*) WHERE source_app='trade_show'` | **375** |
| Receipts | **375** expenses with receipt / **375** receipt rows |
| Zoho ids | **244** (matches TS source) |
| Status mix | approved **290**, pending **85** |
| Spot-check | Zoho id preserved; `midasUrl` absolute duckdns; receipt content HTTP **200** (~1MB) |
| **M8** | `EXT_AUTO_PROVISION_USERS=false` on CT 3120; API restarted; health 200 |

Trade Show re-import skip confirmation is theirs to run; expect `created=0`, all skipped.

**Note (later same day):** live Ext UAT creates raised `trade_show` count to **377** (+2 probe rows). Migrated inventory remains 375 with 375 receipts / 244 Zoho ids.
