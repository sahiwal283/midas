# Zoho Polish + PO Sync Parity — Design (Phase 8)

**Date:** 2026-08-10  
**Status:** Approved  
**Version target:** `0.27.0-alpha`  
**Roadmap:** Sub-project C finish (polish + PO parity).

## Goal

Unify Zoho sync UX for expenses and POs; brand Integration Health; surface error categories and catalog refresh.

## Scope

- Generalize `ZohoSyncCard` for expense + PO (`recordKind`, `zohoRecordId`).
- Wire card on `PurchaseOrderDetail` with Retry → existing push.
- Failed-queue category chips from `[CATEGORY]` in `zohoSyncError`.
- Integration Health: brand polish, live/cache source, Refresh catalog → `POST /transactions/meta/sync-catalog`.

## Out of scope
Mapping admin UI, vendor alias tables, batch retry scheduler.

## Success
- `/api/v1/meta` → `0.27.0-alpha`
- PO detail uses same sync card as expenses
- Catalog refresh from Integration Health
