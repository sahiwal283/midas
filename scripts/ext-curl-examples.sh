#!/usr/bin/env bash
# Curl examples for Trade Show ↔ Midas Ext API (docs/EXT_API_MERGE_LOCK.md)
# Usage:
#   export MIDAS_BASE_URL=http://localhost:4000/api/v1
#   export MIDAS_API_KEY=$(cat .ext-sandbox.key)
#   ./scripts/ext-curl-examples.sh categories   # or create|list|ocr|import-dry

set -euo pipefail
BASE="${MIDAS_BASE_URL:?Set MIDAS_BASE_URL}"
KEY="${MIDAS_API_KEY:?Set MIDAS_API_KEY}"
AUTH=(-H "Authorization: Bearer $KEY")
CMD="${1:-categories}"

case "$CMD" in
  categories)
    curl -sS "$BASE/ext/categories" "${AUTH[@]}" | jq .
    ;;
  ocr)
    FILE="${2:-/tmp/midas-smoke.png}"
    curl -sS -X POST "$BASE/ext/ocr/process" "${AUTH[@]}" -F "file=@$FILE" | jq .
    ;;
  create)
    REF="${2:-demo-$(date +%s)}"
    curl -sS -X POST "$BASE/ext/expenses" "${AUTH[@]}" \
      -H "Content-Type: application/json" \
      -H "X-Actor-External-User-Id: 00000000-0000-4000-8000-000000000001" \
      -d "{
        \"sourceApp\": \"trade_show\",
        \"sourceRefId\": \"$REF\",
        \"submitterEmail\": \"user@midas.local\",
        \"eventId\": \"11111111-1111-4111-8111-111111111111\",
        \"sourceLabel\": \"Demo Event\",
        \"sourceType\": \"trade_show_event\",
        \"merchant\": \"Demo Cafe\",
        \"amount\": 12.34,
        \"date\": \"2026-08-03\",
        \"status\": \"pending\",
        \"categoryName\": \"Meal and Entertainment\"
      }" | jq .
    ;;
  list)
    EVENT="${2:-11111111-1111-4111-8111-111111111111}"
    curl -sS "$BASE/ext/expenses?sourceApp=trade_show&eventId=$EVENT" "${AUTH[@]}" | jq .
    ;;
  by-ref)
    REF="${2:?sourceRefId required}"
    curl -sS "$BASE/ext/expenses/by-ref?sourceApp=trade_show&sourceRefId=$REF" "${AUTH[@]}" | jq .
    ;;
  import-dry)
    curl -sS -X POST "$BASE/ext/expenses/import" "${AUTH[@]}" \
      -H "Content-Type: application/json" \
      -d '{
        "sourceApp": "trade_show",
        "dryRun": true,
        "items": [{
          "sourceRefId": "import-dry-1",
          "submitterEmail": "user@midas.local",
          "eventId": "11111111-1111-4111-8111-111111111111",
          "sourceLabel": "Demo Event",
          "merchant": "Import Dry",
          "amount": 1,
          "date": "2026-08-01",
          "status": "pending",
          "categoryName": "Other"
        }]
      }' | jq .
    ;;
  *)
    echo "Usage: $0 categories|ocr|create|list|by-ref|import-dry [args]"
    exit 1
    ;;
esac
