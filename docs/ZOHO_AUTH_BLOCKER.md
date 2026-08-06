# Zoho push auth — corrected diagnosis (2026-08-03)

## Verdict (updated)

`401 ZOHO_AUTH_INVALID` / `"Authorization required"` was **inbound auth to the Zoho Integration Service**, not Zoho OAuth.

Midas was sending `ZOHO_SERVICE_TOKEN` in **`X-Internal-Token`**. That header is the service’s shared `INTERNAL_API_TOKEN` only. The per-app credential must be:

```http
Authorization: Bearer <ZOHO_SERVICE_TOKEN>
X-Brand: haute_brands
```

`GET /health` is public and does **not** prove app auth.

## Confirmed with Bearer (CT 9503 / 1.34.1)

| Call | Result |
|------|--------|
| `GET /zoho/organizations/list` + Bearer | ✅ success (Haute Brands org `856048585`) |
| `GET /zoho/chartofaccounts/list` + Bearer | ✅ success |
| Same calls + `X-Internal-Token: <app token>` | ❌ `401 ZOHO_AUTH_INVALID` |

## Midas fix

`apps/api/src/lib/zoho.ts` → `serviceHeaders()` sets `Authorization: Bearer …` and does **not** set `X-Internal-Token`.

Enable live push on CT 3120:

```bash
ZOHO_MODE=service
ZOHO_DRY_RUN=false
```

Probe:

```bash
BASE=$(grep ^ZOHO_SERVICE_BASE_URL= /opt/midas/.env | cut -d= -f2-)
TOKEN=$(grep ^ZOHO_SERVICE_TOKEN= /opt/midas/.env | cut -d= -f2-)
BRAND=$(grep ^ZOHO_DEFAULT_BRAND= /opt/midas/.env | cut -d= -f2-)

curl -sS -m 15 -H "Authorization: Bearer $TOKEN" -H "X-Brand: $BRAND" \
  "$BASE/zoho/organizations/list"
```

If you then see `403 ZOHO_AUTH_FORBIDDEN`, that is brand/capability grants for app `midas` — escalate to the Zoho Integration Service team. Real Zoho OAuth failures use codes like `NO_CREDENTIALS` / `TOKEN_EXPIRED`.
