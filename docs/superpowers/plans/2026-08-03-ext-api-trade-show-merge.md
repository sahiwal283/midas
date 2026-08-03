# Ext API Trade Show Merge — Implementation Plan

> **For agentic workers:** Implement task-by-task. Spec: `docs/EXT_API_MERGE_LOCK.md`. Alignment: `docs/CONTRACT_ALIGNMENT.md` (COMPLETE).

**Goal:** Ship the locked `/api/v1/ext/*` surface so Trade Show sandbox can BFF against Midas.

**Architecture:** Expand `ext` routes behind existing Bearer `app_connections`; enforce scopes; add `source_context` + `external_user_id`; reuse `ocr.process` (standalone) and `runReceiptOcr` (receipt attach); wrap `@midas/import` for HTTP import.

## File map

| File | Responsibility |
|---|---|
| `apps/api/src/db/schema.ts` | Schema adds |
| `apps/api/src/db/seed.ts` | TS category names + mappings |
| `apps/api/src/config/env.ts` | `EXT_AUTO_PROVISION_USERS` |
| `apps/api/src/middleware/auth.ts` | `requireScope`, typed `appConnection` |
| `apps/api/src/lib/ext/*` | DTO, user resolve, status maps, midasUrl |
| `apps/api/src/routes/ext.ts` (+ optional `ext/*.ts`) | All Required endpoints |
| `packages/shared` | `ReimbursementStatus` += `rejected` |
| `packages/import` | Upsert + skipOcr + sha256 fields as needed |
| `apps/api/src/__tests__/ext*.test.ts` | Scope, idempotency, delete rules |
| `.env.example` | Document new env |

## Tasks

1. Schema + env + shared types  
2. Auth scope middleware  
3. Ext helpers (DTO, maps, provision)  
4. Ext routes: OCR, categories, CRUD/list/by-ref, PATCH, DELETE  
5. Ext receipts upload/content  
6. Ext import HTTP + import package gaps  
7. Seed categories/mappings  
8. Tests + lint  

## Out of scope (v1)

Ext review / reimbursement / zoho-push; signed S3 URLs; preserveId stretch.

## Status (2026-08-03)

Implemented in Midas repo:
- Schema: `source_context`, `external_user_id`, `reimbursement rejected`, receipt `sha256`, `category_mappings`
- Auth: `requireScope` + typed `appConnection`
- Ext routes: all Required endpoints in `apps/api/src/routes/ext.ts`
- Seed: Trade Show category names + OCR mappings
- Tests: maps + scopes (174 API unit tests green)

**Ops remaining (CT / remote sandbox):** deploy API + schema, seed, issue connection key, `EXT_AUTO_PROVISION_USERS=true`.

**Local (done 2026-08-03):** schema push, seed, `trade_show` key, API on :4000, full `ext:smoke` green (15 checks).

**Midas v1 Ext work COMPLETE.** Handover for Trade Show agent: `docs/TRADE_SHOW_AGENT_HANDOVER.md`.
