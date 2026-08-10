# Branding + UI Redesign — Design

**Date:** 2026-08-10  
**Status:** Approved  
**Version target:** `0.23.0-alpha`  
**Phase:** 4 (Phase 5 = launch hardening)

## Goal

Make Midas read as a finished premium expense product (financial software + Haute gold), not a generic internal admin tool — without changing core workflows.

## Visual identity

### Logo
Abstract geometric **M** from two gold arcs/planes (coin / crown / upward cue). Not a literal coin or mythology. Wordmark **MIDAS** beside the mark; tagline **Expense management** on login only.

### Palette
| Token | Hex | Role |
|-------|-----|------|
| ink | `#171717` | Primary text |
| charcoal | `#242424` | Secondary text |
| cream | `#FAF9F6` | Page background |
| white | `#FFFFFF` | Elevated panels |
| gold | `#C9A227` | Accent / primary CTA / active nav |
| green | `#2F7D5A` | Success |
| red | `#C94C4C` | Danger / failed |

Gold is accent, never a full-page fill. Tailwind `brand.*` stays gold-centered; semantic `ink` / `cream` / `success` / `danger` tokens added.

### Typography
- Display: **Fraunces** (titles)
- UI: **DM Sans** (body, controls)
- Loaded via Google Fonts in `index.html` / `index.css`

### Surfaces
Cream canvas; white panels with hairline borders (`ink` at ~8–12% opacity); gold for primary buttons and active nav; soft shadow only when interaction needs affordance.

## Navigation IA

### Employee
Dashboard · Expenses · Add Transaction · To Upload · Get Extension · Settings

### Accountant
Review Queue · Purchase Orders · Reports · Integration Health · Reimbursements (→ queue `?reimbursementStatus=pending`)

### Admin (admin/developer)
Settings remains host; sidebar labels mirror: Users, Companies, Categories / Payment Methods / Budgets, Connections, Audit Log as deep links into Settings sections where practical, or keep Settings as single entry with improved internal groups.

### Mobile
Bottom nav: Dashboard, Expenses, Add, Queue (privileged), More.

## Page polish
- **Login:** Brand-first mark + MIDAS + Expense management; cream/ink; gold CTA
- **Dashboard:** Greeting + attention lanes; reduce tile noise
- **Expenses / Detail / New:** Token alignment; tighter lists
- **Accountant / PO queues / Reports:** Stronger headers, denser tables, gold primary actions

## Out of scope (Phase 5)
CORS extension allowlist, audit immutability, Zoho E2E, Authentik rotation, anomaly detection, API redesign.

## Success criteria
- `/api/v1/meta` → `0.23.0-alpha` after deploy
- Login + sidebar show new mark and cream/gold system
- No workflow regressions (routes and actions unchanged)
