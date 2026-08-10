# Employee Capture Polish — Design (Phase 6)

**Date:** 2026-08-10  
**Status:** Approved  
**Version target:** `0.25.0-alpha`  
**Roadmap:** Sub-project A finish (gaps + wizard polish). Phases 7–8 = B then C.

## Goal

Make employee capture feel finished in the cream/ink/gold brand without changing API or schema contracts.

## Scope

### Wizard (`ExpenseNew`)
- Restyle to cream canvas, white panels, gold primary, Fraunces headers.
- Light step chrome: Choose → Details → Done (hint text, not a heavy progress rail).
- Keep existing draft → OCR → submit flow and confidence warnings.
- Done-state copy: “Approved ✓” / “Submitted for review” / sent-to-accounting clarification.

### Home (`Dashboard` employee view)
- Action-first subtitle and lanes (“needs your attention”).
- Recent list uses employee status labels with checkmarks where appropriate.
- Primary CTA remains Add Transaction.

### Status language
- Employee badges: **Approved ✓** / **Accounting complete ✓** (existing `userStatusLabel` + `zohoExpenseId`).
- Ensure `zohoExpenseId` is passed on employee list/detail/dashboard surfaces.

### Company wording
- Employee-facing “Entity” / “Brand / entity” → **Company** (especially ExpenseDetail).

### Upload banner
- Keep `UploadRetryBanner`; align to brand attention tokens.

## Out of scope
Accountant bulk tools (B), Zoho mapping/vendor policy/sync history (C), PO wizard redesign, migrations.

## Success
- `/api/v1/meta` → `0.25.0-alpha`
- Add Expense choose → OCR → submit reads as one branded flow on phone + desktop
- Home leads with attention, not vanity stats
- No API/schema migrations
