#!/usr/bin/env bash
# Midas smoke test — run after any deployment to verify core flows.
# Usage:
#   source scripts/.env.test && bash scripts/smoke-test.sh   # preferred
#   API_URL=http://192.168.1.210:4000 WEB_URL=http://192.168.1.210:5173 \
#     MIDAS_TEST_ADMIN_PASSWORD=<pass> bash scripts/smoke-test.sh
#
# Credential env vars (MIDAS_TEST_* preferred; ADMIN_PASS/ADMIN_EMAIL accepted for compat):
#   MIDAS_TEST_ADMIN_EMAIL     (default: admin@midas.local)
#   MIDAS_TEST_ADMIN_PASSWORD  (required for auth-dependent checks)
#
# Exit code 0 = all checks passed. Non-zero = at least one check failed.

set -euo pipefail

API_URL="${API_URL:-http://localhost:4000}"
WEB_URL="${WEB_URL:-http://localhost:5173}"
ADMIN_EMAIL="${MIDAS_TEST_ADMIN_EMAIL:-${ADMIN_EMAIL:-admin@midas.local}}"
ADMIN_PASS="${MIDAS_TEST_ADMIN_PASSWORD:-${ADMIN_PASS:-}}"

PASS=0
FAIL=0
COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

# ── helpers ───────────────────────────────────────────────────────────────────

green() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
red()   { printf '\033[31m✗ %s\033[0m\n' "$*"; }

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    green "$label"; (( PASS++ )) || true
  else
    red "$label"; (( FAIL++ )) || true
  fi
}

# Run curl, capture HTTP status, check against expected
http_check() {
  local label="$1"
  local expected="$2"
  shift 2
  local status
  status=$(curl -s -o /tmp/smoke_body -w "%{http_code}" "$@")
  if [ "$status" = "$expected" ]; then
    green "$label (HTTP $status)"
    (( PASS++ )) || true
    return 0
  else
    red "$label (expected HTTP $expected, got $status)"
    cat /tmp/smoke_body 2>/dev/null | head -3
    (( FAIL++ )) || true
    return 1
  fi
}

echo "Midas Smoke Test"
echo "API: $API_URL"
echo "Web: $WEB_URL"
echo "──────────────────────────────────────"

# ── 1. API health ─────────────────────────────────────────────────────────────

http_check "API health endpoint" "200" "$API_URL/api/v1/health"

# ── 1b. Meta endpoint ─────────────────────────────────────────────────────────

META_STATUS=$(curl -s -o /tmp/smoke_meta -w "%{http_code}" "$API_URL/api/v1/meta")
if [ "$META_STATUS" = "200" ]; then
  VERSION=$(python3 -c "import json; print(json.load(open('/tmp/smoke_meta')).get('version','?'))" 2>/dev/null || echo "?")
  green "Meta endpoint — version $VERSION"
  (( PASS++ )) || true
else
  red "Meta endpoint — expected HTTP 200, got $META_STATUS"
  (( FAIL++ )) || true
fi

# ── 2. Frontend reachable ─────────────────────────────────────────────────────

http_check "Frontend returns HTML" "200" "$WEB_URL/"

# ── 3. Login ──────────────────────────────────────────────────────────────────

if [ -z "$ADMIN_PASS" ]; then
  red "Login skipped — MIDAS_TEST_ADMIN_PASSWORD not set"
  (( FAIL++ )) || true
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  echo "Set MIDAS_TEST_ADMIN_PASSWORD=<password> (or source scripts/.env.test) to run auth-dependent checks."
  exit $FAIL
fi

LOGIN_STATUS=$(curl -s -o /tmp/smoke_login -w "%{http_code}" \
  -X POST "$API_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" \
  -c "$COOKIE_JAR")

if [ "$LOGIN_STATUS" = "200" ]; then
  green "Login ($ADMIN_EMAIL) — HTTP 200"
  (( PASS++ )) || true
else
  red "Login ($ADMIN_EMAIL) — expected HTTP 200, got $LOGIN_STATUS"
  cat /tmp/smoke_login 2>/dev/null | head -3
  (( FAIL++ )) || true
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  echo "Login failed — skipping auth-required checks."
  exit $FAIL
fi

# ── 4. Extension categories endpoint ─────────────────────────────────────────

CATS_STATUS=$(curl -s -o /tmp/smoke_cats -w "%{http_code}" \
  "$API_URL/api/v1/extension/categories" \
  -b "$COOKIE_JAR")

if [ "$CATS_STATUS" = "200" ]; then
  COUNT=$(python3 -c "import sys,json; d=json.load(open('/tmp/smoke_cats')); print(len(d.get('categories',[])))" 2>/dev/null || echo "?")
  green "Extension categories — $COUNT categories returned"
  (( PASS++ )) || true
else
  red "Extension categories — expected HTTP 200, got $CATS_STATUS"
  (( FAIL++ )) || true
fi

# ── 5. Create expense ─────────────────────────────────────────────────────────

EXPENSE_STATUS=$(curl -s -o /tmp/smoke_expense -w "%{http_code}" \
  -X POST "$API_URL/api/v1/expenses" \
  -H "Content-Type: application/json" \
  -b "$COOKIE_JAR" \
  -d '{
    "merchant": "Smoke Test Merchant",
    "amount": 1.00,
    "date": "'"$(date +%Y-%m-%d)"'",
    "currency": "USD",
    "description": "Automated smoke test — safe to delete"
  }')

EXPENSE_ID=""
if [ "$EXPENSE_STATUS" = "201" ]; then
  EXPENSE_ID=$(python3 -c "import sys,json; print(json.load(open('/tmp/smoke_expense'))['expense']['id'])" 2>/dev/null || echo "")
  green "Create expense — HTTP 201 (id: ${EXPENSE_ID:-unknown})"
  (( PASS++ )) || true
else
  red "Create expense — expected HTTP 201, got $EXPENSE_STATUS"
  cat /tmp/smoke_expense 2>/dev/null | head -3
  (( FAIL++ )) || true
fi

# ── 6. Accountant queue ───────────────────────────────────────────────────────

QUEUE_STATUS=$(curl -s -o /tmp/smoke_queue -w "%{http_code}" \
  "$API_URL/api/v1/accountant/queue" \
  -b "$COOKIE_JAR")

if [ "$QUEUE_STATUS" = "200" ]; then
  COUNT=$(python3 -c "import sys,json; d=json.load(open('/tmp/smoke_queue')); print(len(d.get('expenses',[])))" 2>/dev/null || echo "?")
  green "Accountant queue — $COUNT expenses in queue"
  (( PASS++ )) || true
else
  red "Accountant queue — expected HTTP 200, got $QUEUE_STATUS"
  (( FAIL++ )) || true
fi

# ── 7. Cleanup — delete the smoke test expense ────────────────────────────────

if [ -n "$EXPENSE_ID" ]; then
  DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X DELETE "$API_URL/api/v1/expenses/$EXPENSE_ID" \
    -b "$COOKIE_JAR")
  if [ "$DEL_STATUS" = "200" ] || [ "$DEL_STATUS" = "204" ]; then
    green "Smoke test expense deleted (${EXPENSE_ID})"
    (( PASS++ )) || true
  else
    # Non-fatal — the expense is just left in draft status
    printf '\033[33m~ Smoke expense cleanup returned HTTP %s (non-fatal)\033[0m\n' "$DEL_STATUS"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo "──────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mAll %d checks passed.\033[0m\n' "$PASS"
else
  printf '\033[31m%d passed, %d FAILED.\033[0m\n' "$PASS" "$FAIL"
fi
exit $FAIL
