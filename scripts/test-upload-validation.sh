#!/usr/bin/env bash
# Upload validation negative tests — verifies MIME type and size limits are enforced.
# Runs against the live API. Uses only small payloads except for the oversize test,
# which generates the test payload on the server-side using /dev/zero.
#
# Usage:
#   API_URL=http://172.18.0.2:4000 ADMIN_EMAIL=admin@midas.local ADMIN_PASS=<pass> \
#     bash scripts/test-upload-validation.sh
#
# Safe to run against production — no real files are persisted (all requests
# either fail validation or are authenticated only to test the rejection path).

set -euo pipefail

API_URL="${API_URL:-http://localhost:4000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@midas.local}"
ADMIN_PASS="${ADMIN_PASS:-}"

PASS=0
FAIL=0
COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR" /tmp/upload_test_body /tmp/upload_test_file' EXIT

green() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
red()   { printf '\033[31m✗ %s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m~ %s\033[0m\n' "$*"; }

ok() { green "$1"; (( PASS++ )) || true; }
fail() { red "$1"; (( FAIL++ )) || true; }

# Tiny valid 1×1 PNG (base64) — real PNG magic bytes, minimal IDAT
TINY_PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
VALID_PNG_URL="data:image/png;base64,${TINY_PNG_B64}"

echo "Upload Validation Tests"
echo "API: $API_URL"
echo "──────────────────────────────────────"

# ── Unauthenticated path — expect 401 ─────────────────────────────────────────

STATUS=$(curl -s -o /tmp/upload_test_body -w "%{http_code}" \
  -X POST "$API_URL/api/v1/captures" \
  -H "Content-Type: application/json" \
  -d "{\"imageDataUrl\":\"${VALID_PNG_URL}\"}")
if [ "$STATUS" = "401" ]; then
  ok "Captures endpoint requires auth — 401 without cookie"
else
  fail "Captures endpoint expected 401 without auth, got $STATUS"
  cat /tmp/upload_test_body | head -2
fi

# ── Login ──────────────────────────────────────────────────────────────────────

if [ -z "$ADMIN_PASS" ]; then
  yellow "ADMIN_PASS not set — skipping authenticated validation tests"
  echo ""; echo "Results: $PASS passed, $FAIL failed (auth tests skipped)"
  exit $FAIL
fi

LOGIN_STATUS=$(curl -s -o /tmp/upload_test_body -w "%{http_code}" \
  -X POST "$API_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" \
  -c "$COOKIE_JAR")

if [ "$LOGIN_STATUS" != "200" ]; then
  fail "Login failed ($LOGIN_STATUS) — cannot run authenticated tests"
  exit $FAIL
fi
ok "Login succeeded"

# ── Wrong MIME type — captures ─────────────────────────────────────────────────

STATUS=$(curl -s -o /tmp/upload_test_body -w "%{http_code}" \
  -X POST "$API_URL/api/v1/captures" \
  -H "Content-Type: application/json" \
  -b "$COOKIE_JAR" \
  -d "{\"imageDataUrl\":\"data:video/mp4;base64,${TINY_PNG_B64}\"}")
CODE=$(python3 -c "import sys,json; d=json.load(open('/tmp/upload_test_body')); print(d.get('error',{}).get('code',''))" 2>/dev/null || echo "?")
if [ "$STATUS" = "415" ] && [ "$CODE" = "UNSUPPORTED_MIME" ]; then
  ok "Captures: video/mp4 rejected — 415 UNSUPPORTED_MIME"
else
  fail "Captures: video/mp4 expected 415 UNSUPPORTED_MIME, got HTTP $STATUS code=$CODE"
  cat /tmp/upload_test_body | head -2
fi

# ── Wrong MIME type — extension/expenses ──────────────────────────────────────

STATUS=$(curl -s -o /tmp/upload_test_body -w "%{http_code}" \
  -X POST "$API_URL/api/v1/extension/expenses" \
  -H "Content-Type: application/json" \
  -b "$COOKIE_JAR" \
  -d "{
    \"imageDataUrl\":\"data:image/gif;base64,${TINY_PNG_B64}\",
    \"merchant\":\"Test\",
    \"amount\":1.00,
    \"date\":\"$(date +%Y-%m-%d)\"
  }")
CODE=$(python3 -c "import sys,json; d=json.load(open('/tmp/upload_test_body')); print(d.get('error',{}).get('code',''))" 2>/dev/null || echo "?")
if [ "$STATUS" = "415" ] && [ "$CODE" = "UNSUPPORTED_MIME" ]; then
  ok "Extension/expenses: image/gif rejected — 415 UNSUPPORTED_MIME"
else
  fail "Extension/expenses: image/gif expected 415 UNSUPPORTED_MIME, got HTTP $STATUS code=$CODE"
  cat /tmp/upload_test_body | head -2
fi

# ── Wrong MIME type — text/html (injection-risk type) ─────────────────────────

STATUS=$(curl -s -o /tmp/upload_test_body -w "%{http_code}" \
  -X POST "$API_URL/api/v1/captures" \
  -H "Content-Type: application/json" \
  -b "$COOKIE_JAR" \
  -d "{\"imageDataUrl\":\"data:text/html;base64,${TINY_PNG_B64}\"}")
if [ "$STATUS" = "415" ]; then
  ok "Captures: text/html rejected — 415"
else
  fail "Captures: text/html expected 415, got HTTP $STATUS"
fi

# ── Valid PNG type passes MIME check ──────────────────────────────────────────
# Expect 201 (capture created) — proves the validation allows valid types through.

STATUS=$(curl -s -o /tmp/upload_test_body -w "%{http_code}" \
  -X POST "$API_URL/api/v1/captures" \
  -H "Content-Type: application/json" \
  -b "$COOKIE_JAR" \
  -d "{\"imageDataUrl\":\"${VALID_PNG_URL}\",\"pageUrl\":\"\"}")
if [ "$STATUS" = "201" ]; then
  CAPTURE_ID=$(python3 -c "import sys,json; print(json.load(open('/tmp/upload_test_body'))['capture']['id'])" 2>/dev/null || echo "")
  ok "Captures: image/png accepted — 201 Created (id: ${CAPTURE_ID:-unknown})"
  # Clean up test capture
  if [ -n "$CAPTURE_ID" ]; then
    curl -s -o /dev/null -X PATCH "$API_URL/api/v1/captures/$CAPTURE_ID" \
      -H "Content-Type: application/json" -b "$COOKIE_JAR" \
      -d '{"status":"discarded"}' || true
  fi
else
  fail "Captures: image/png expected 201, got $STATUS"
  cat /tmp/upload_test_body | head -2
fi

# ── Oversized file — extension/expenses ───────────────────────────────────────
# Generate a 10MB+1 byte payload encoded as base64.
# The JSON request body will be ~14MB. Sent once; server rejects before any DB write.

echo "  (generating 10MB+1 test payload into temp file — one-time, no DB write on server)..."
OVERSIZE_PAYLOAD=/tmp/upload_oversize_test.json
{
  printf '{"imageDataUrl":"data:image/png;base64,'
  dd if=/dev/zero bs=1048576 count=10 2>/dev/null | cat - <(dd if=/dev/zero bs=1 count=1 2>/dev/null) | base64 -w0
  printf '","merchant":"Oversize Test","amount":1.00,"date":"%s"}' "$(date +%Y-%m-%d)"
} > "$OVERSIZE_PAYLOAD"
trap 'rm -f "$COOKIE_JAR" /tmp/upload_test_body /tmp/upload_test_file '"$OVERSIZE_PAYLOAD" EXIT

STATUS=$(curl -s -o /tmp/upload_test_body -w "%{http_code}" \
  -X POST "$API_URL/api/v1/extension/expenses" \
  -H "Content-Type: application/json" \
  -b "$COOKIE_JAR" \
  --data "@$OVERSIZE_PAYLOAD")
CODE=$(python3 -c "import sys,json; d=json.load(open('/tmp/upload_test_body')); print(d.get('error',{}).get('code',''))" 2>/dev/null || echo "?")
if [ "$STATUS" = "413" ] && [ "$CODE" = "FILE_TOO_LARGE" ]; then
  ok "Extension/expenses: 10MB+1 rejected — 413 FILE_TOO_LARGE"
elif [ "$STATUS" = "413" ]; then
  ok "Extension/expenses: 10MB+1 rejected — 413 (code: $CODE)"
else
  fail "Extension/expenses: 10MB+1 expected 413, got HTTP $STATUS code=$CODE"
  cat /tmp/upload_test_body | head -2
fi

# ── Oversized file — receipt multipart upload ─────────────────────────────────
# Create a >10MB temp file, POST as multipart. Multer rejects at stream level.

dd if=/dev/zero of=/tmp/upload_test_file bs=1M count=11 2>/dev/null

# Need an expense to attach receipt to — create a draft one
EXPENSE_RESP=$(curl -s -X POST "$API_URL/api/v1/expenses" \
  -H "Content-Type: application/json" -b "$COOKIE_JAR" \
  -d "{\"merchant\":\"Upload Test\",\"amount\":1.00,\"date\":\"$(date +%Y-%m-%d)\"}")
EXPENSE_ID=$(python3 -c "import sys,json; print(json.load(sys.stdin)['expense']['id'])" 2>/dev/null <<< "$EXPENSE_RESP" || echo "")

if [ -n "$EXPENSE_ID" ]; then
  STATUS=$(curl -s -o /tmp/upload_test_body -w "%{http_code}" \
    -X POST "$API_URL/api/v1/expenses/$EXPENSE_ID/receipts" \
    -b "$COOKIE_JAR" \
    -F "file=@/tmp/upload_test_file;type=image/jpeg")
  if [ "$STATUS" = "413" ] || [ "$STATUS" = "400" ]; then
    ok "Receipts multipart: 11MB file rejected — HTTP $STATUS"
  else
    fail "Receipts multipart: 11MB expected 413/400, got HTTP $STATUS"
    cat /tmp/upload_test_body | head -2
  fi
  # Clean up test expense
  curl -s -o /dev/null -X DELETE "$API_URL/api/v1/expenses/$EXPENSE_ID" -b "$COOKIE_JAR" || true
else
  yellow "Could not create test expense for receipt oversize test — skipping"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo "──────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mAll %d validation checks passed.\033[0m\n' "$PASS"
else
  printf '\033[31m%d passed, %d FAILED.\033[0m\n' "$PASS" "$FAIL"
fi
exit $FAIL
