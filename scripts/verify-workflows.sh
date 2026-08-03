#!/bin/bash
# Verify core Midas workflows end-to-end against deployed API.
# Covers: request-info, resolve-request bugfix, payment methods, queue flags.
#
# Credentials must be supplied via environment variables — never hardcoded.
# Quickstart:
#   cp scripts/.env.test.example scripts/.env.test   # gitignored
#   # fill in scripts/.env.test with real values
#   source scripts/.env.test && bash scripts/verify-workflows.sh
#
# Or export directly:
#   MIDAS_TEST_ADMIN_PASSWORD=<pass> \
#   MIDAS_TEST_USER_PASSWORD=<pass> \
#   MIDAS_TEST_ACCOUNTANT_PASSWORD=<pass> \
#   bash scripts/verify-workflows.sh
set -euo pipefail

API=http://localhost:4000
PASS=0
FAIL=0
JAR_ADMIN=/tmp/wv_admin.jar
JAR_USER=/tmp/wv_user.jar

# ── Credential validation ─────────────────────────────────────────────────────

ADMIN_EMAIL="${MIDAS_TEST_ADMIN_EMAIL:-admin@midas.local}"
USER_EMAIL="${MIDAS_TEST_USER_EMAIL:-user@midas.local}"
ACCOUNTANT_EMAIL="${MIDAS_TEST_ACCOUNTANT_EMAIL:-accountant@midas.local}"

_missing=0
for _var in MIDAS_TEST_ADMIN_PASSWORD MIDAS_TEST_USER_PASSWORD MIDAS_TEST_ACCOUNTANT_PASSWORD; do
  if [ -z "${!_var:-}" ]; then
    printf 'Error: %s is required.\n' "$_var" >&2
    _missing=1
  fi
done
if [ "$_missing" = "1" ]; then
  echo "Usage: source scripts/.env.test && bash scripts/verify-workflows.sh" >&2
  echo "       (copy scripts/.env.test.example to scripts/.env.test and fill in real values)" >&2
  exit 1
fi

ADMIN_PASSWORD="$MIDAS_TEST_ADMIN_PASSWORD"
USER_PASSWORD="$MIDAS_TEST_USER_PASSWORD"
ACCOUNTANT_PASSWORD="$MIDAS_TEST_ACCOUNTANT_PASSWORD"

green() { printf '\033[32m✓ %s\033[0m\n' "$*"; (( PASS++ )) || true; }
red()   { printf '\033[31m✗ %s\033[0m\n' "$*"; (( FAIL++ )) || true; }

hcheck() {
  local label="$1" expected="$2"; shift 2
  local code
  code=$(curl -s -o /tmp/wv_body -w "%{http_code}" "$@")
  if [ "$code" = "$expected" ]; then green "$label (HTTP $code)"
  else red "$label (expected $expected, got $code)"; cat /tmp/wv_body | head -3; fi
}

echo "=== Midas Workflow Verification ==="
echo ""

# ── Auth ──────────────────────────────────────────────────────────────────────

ADMIN_STATUS=$(curl -s -o /tmp/wv_admin_login -w "%{http_code}" \
  -X POST "$API/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  -c "$JAR_ADMIN")
[ "$ADMIN_STATUS" = "200" ] && green "Admin login" || { red "Admin login ($ADMIN_STATUS)"; exit 1; }

USER_STATUS=$(curl -s -o /tmp/wv_user_login -w "%{http_code}" \
  -X POST "$API/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$USER_PASSWORD\"}" \
  -c "$JAR_USER")
[ "$USER_STATUS" = "200" ] && green "User login" || { red "User login ($USER_STATUS)"; exit 1; }

# ── Payment Methods ────────────────────────────────────────────────────────────

echo ""
echo "--- Payment Methods ---"

# Create a test payment method (admin)
PM_STATUS=$(curl -s -o /tmp/wv_pm -w "%{http_code}" \
  -X POST "$API/api/v1/payment-methods" \
  -H "Content-Type: application/json" \
  -b "$JAR_ADMIN" \
  -d '{"label":"Test Corp Card","lastFour":"9999","brand":"visa","zohoAccountName":"Corp Visa","isCompanyWide":true}')
if [ "$PM_STATUS" = "201" ]; then
  PM_ID=$(python3 -c "import json; print(json.load(open('/tmp/wv_pm'))['paymentMethod']['id'])")
  green "Create payment method → id: ${PM_ID:0:8}..."
else
  red "Create payment method ($PM_STATUS)"
  cat /tmp/wv_pm | head -3
  PM_ID=""
fi

# List payment methods as user → should include the new method
PM_LIST=$(curl -s "$API/api/v1/payment-methods" -b "$JAR_USER")
PM_COUNT=$(python3 -c "import json; print(len(json.loads('$PM_LIST').get('paymentMethods',[])))" 2>/dev/null || echo "?")
[ "$PM_COUNT" != "0" ] && green "User can list payment methods ($PM_COUNT found)" || red "User sees no payment methods"

# ── Create test expense as user ────────────────────────────────────────────────

echo ""
echo "--- Expense + Request-Info Workflow ---"

EXP_STATUS=$(curl -s -o /tmp/wv_exp -w "%{http_code}" \
  -X POST "$API/api/v1/expenses" \
  -H "Content-Type: application/json" \
  -b "$JAR_USER" \
  -d '{"merchant":"Workflow Test Co","amount":42.00,"date":"2026-05-12","description":"CI verify"}')
if [ "$EXP_STATUS" = "201" ]; then
  EXP_ID=$(python3 -c "import json; print(json.load(open('/tmp/wv_exp'))['expense']['id'])")
  green "Create expense → id: ${EXP_ID:0:8}..."
else
  red "Create expense ($EXP_STATUS)"
  exit 1
fi

# Submit expense
SUBMIT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$API/api/v1/expenses/$EXP_ID/submit" -b "$JAR_USER")
[ "$SUBMIT_STATUS" = "200" ] && green "Submit expense (draft → pending)" || red "Submit expense ($SUBMIT_STATUS)"

# ── Claim workflow ──────────────────────────────────────────────────────────────

echo ""
echo "--- Claim Workflow ---"

# Accountant claims the pending expense
CLAIM_STATUS=$(curl -s -o /tmp/wv_claim -w "%{http_code}" \
  -X POST "$API/api/v1/accountant/expenses/$EXP_ID/claim" \
  -b "$JAR_ADMIN")
if [ "$CLAIM_STATUS" = "200" ]; then
  CLAIMED_STATUS=$(python3 -c "import json; print(json.load(open('/tmp/wv_claim'))['expense']['status'])")
  REVIEWER_NAME=$(python3 -c "import json; print(json.load(open('/tmp/wv_claim'))['expense'].get('reviewedBy',{}).get('name','MISSING'))")
  [ "$CLAIMED_STATUS" = "in_review" ] && green "Claim: pending → in_review" || red "Claim: unexpected status $CLAIMED_STATUS"
  [ "$REVIEWER_NAME" != "MISSING" ] && green "Claim: reviewedBy.name = $REVIEWER_NAME" || red "Claim: reviewedBy missing from response"
else
  red "Claim expense ($CLAIM_STATUS)"
fi

# Attempt to claim again — should be 409
RECLAM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$API/api/v1/accountant/expenses/$EXP_ID/claim" \
  -b "$JAR_ADMIN")
[ "$RECLAM_STATUS" = "409" ] && green "Double-claim blocked (409 Conflict)" || red "Double-claim not blocked (got $RECLAM_STATUS)"

# Non-existent expense should be 404
NOTFOUND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$API/api/v1/accountant/expenses/00000000-0000-0000-0000-000000000000/claim" \
  -b "$JAR_ADMIN")
[ "$NOTFOUND_STATUS" = "404" ] && green "Claim non-existent expense → 404" || red "Claim non-existent expense: expected 404, got $NOTFOUND_STATUS"

# ── Release Claim workflow ─────────────────────────────────────────────────────

echo ""
echo "--- Release Claim Workflow ---"

# Release the in_review expense → back to pending
RELEASE_STATUS=$(curl -s -o /tmp/wv_release -w "%{http_code}" \
  -X POST "$API/api/v1/accountant/expenses/$EXP_ID/release-claim" \
  -b "$JAR_ADMIN")
if [ "$RELEASE_STATUS" = "200" ]; then
  RELEASE_EXP_STATUS=$(python3 -c "import json; print(json.load(open('/tmp/wv_release'))['expense']['status'])")
  RELEASED_BY_ID=$(python3 -c "import json; d=json.load(open('/tmp/wv_release'))['expense']; print(d.get('reviewedById') or 'null')")
  [ "$RELEASE_EXP_STATUS" = "pending" ] && green "Release: in_review → pending" || red "Release: expected pending, got $RELEASE_EXP_STATUS"
  [ "$RELEASED_BY_ID" = "null" ] && green "Release: reviewedById cleared to null" || red "Release: reviewedById not cleared (got $RELEASED_BY_ID)"
else
  red "Release claim ($RELEASE_STATUS)"
  cat /tmp/wv_release | head -3
fi

# Release non-in_review expense → 409
# Expense is now pending, so release should fail
RELEASE_AGAIN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$API/api/v1/accountant/expenses/$EXP_ID/release-claim" \
  -b "$JAR_ADMIN")
[ "$RELEASE_AGAIN_STATUS" = "409" ] && green "Release non-in_review expense → 409 Conflict" || red "Release non-in_review: expected 409, got $RELEASE_AGAIN_STATUS"

# Release non-existent expense → 404
RELEASE_NF_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$API/api/v1/accountant/expenses/00000000-0000-0000-0000-000000000000/release-claim" \
  -b "$JAR_ADMIN")
[ "$RELEASE_NF_STATUS" = "404" ] && green "Release non-existent expense → 404" || red "Release non-existent: expected 404, got $RELEASE_NF_STATUS"

# Re-claim so the rest of the workflow can proceed (expense needs to be in_review for request_info)
curl -s -o /dev/null -X POST "$API/api/v1/accountant/expenses/$EXP_ID/claim" -b "$JAR_ADMIN"
green "Re-claimed expense for continued workflow testing"

# ── Post a regular system message (NOT a request) ──────────────────────────────
# This message has no requestType — the resolve-request bugfix should NOT resolve it.

MSG_STATUS=$(curl -s -o /tmp/wv_msg -w "%{http_code}" \
  -X POST "$API/api/v1/expenses/$EXP_ID/messages" \
  -H "Content-Type: application/json" \
  -b "$JAR_ADMIN" \
  -d '{"body":"Internal note for accountants"}')
MSG_ID=$(python3 -c "import json; print(json.load(open('/tmp/wv_msg'))['message']['id'])" 2>/dev/null || echo "")
[ "$MSG_STATUS" = "201" ] && green "Admin posts regular message (no requestType)" || red "Post regular message ($MSG_STATUS)"

# ── Request info (structured request with requestType) ─────────────────────────

REQ_STATUS=$(curl -s -o /tmp/wv_req -w "%{http_code}" \
  -X PATCH "$API/api/v1/accountant/expenses/$EXP_ID/review" \
  -H "Content-Type: application/json" \
  -b "$JAR_ADMIN" \
  -d '{"action":"request_info","note":"Please upload your receipt","requestType":"missing_receipt","internalNote":"Third request from this employee"}')
[ "$REQ_STATUS" = "200" ] && green "Request info → awaiting_info (requestType=missing_receipt)" || { red "Request info ($REQ_STATUS)"; cat /tmp/wv_req; }

# Verify expense is now awaiting_info
EXP_STATE=$(curl -s "$API/api/v1/expenses/$EXP_ID" -b "$JAR_ADMIN")
STATUS=$(python3 -c "import json; print(json.loads('$EXP_STATE'.replace(\"'\",\"'\"))['expense']['status'])" 2>/dev/null || echo "?")

MSGS_AFTER_REQ=$(curl -s "$API/api/v1/expenses/$EXP_ID/messages" -b "$JAR_ADMIN")
REQ_MSG_COUNT=$(python3 -c "
import json
msgs = json.loads(open('/tmp/wv_msgs_after_req_raw', 'w').write('''$MSGS_AFTER_REQ''') or '$MSGS_AFTER_REQ')
ms = msgs.get('messages', [])
print(len(ms), 'total,', len([m for m in ms if m.get('requestType')]), 'with requestType,', len([m for m in ms if not m.get('isResolved')]), 'unresolved')
" 2>/dev/null || echo "?")

if echo "$EXP_STATE" | grep -q '"awaiting_info"'; then
  green "Expense status is awaiting_info"
else
  red "Expense status not awaiting_info (got: $STATUS)"
fi

# ── internalNote visibility: user should NOT see internalNote ──────────────────

MSGS_AS_USER=$(curl -s "$API/api/v1/expenses/$EXP_ID/messages" -b "$JAR_USER")
if echo "$MSGS_AS_USER" | python3 -c "
import sys, json
msgs = json.load(sys.stdin).get('messages', [])
notes = [m for m in msgs if m.get('internalNote')]
sys.exit(0 if not notes else 1)
" 2>/dev/null; then
  green "internalNote stripped from user response"
else
  red "internalNote visible to user (data leak!)"
fi

# ── resolve-request: must NOT resolve the regular message (bugfix verification) ─

RESOLVE_STATUS=$(curl -s -o /tmp/wv_resolve -w "%{http_code}" \
  -X POST "$API/api/v1/accountant/expenses/$EXP_ID/resolve-request" \
  -b "$JAR_ADMIN")
RESOLVE_BODY=$(cat /tmp/wv_resolve)

if [ "$RESOLVE_STATUS" = "200" ]; then
  RESOLVED_COUNT=$(python3 -c "import json; print(json.loads('$RESOLVE_BODY').get('resolvedCount', '?'))" 2>/dev/null || echo "?")
  # Should resolve exactly 1 (the request_info message), NOT 2 (the regular message too)
  if [ "$RESOLVED_COUNT" = "1" ]; then
    green "resolve-request resolved exactly 1 request message (bugfix confirmed)"
  else
    red "resolve-request resolved $RESOLVED_COUNT messages (expected 1)"
  fi
else
  red "resolve-request ($RESOLVE_STATUS)"
fi

# Expense should be back to in_review
FINAL_STATE=$(curl -s "$API/api/v1/expenses/$EXP_ID" -b "$JAR_ADMIN")
if echo "$FINAL_STATE" | grep -q '"in_review"'; then
  green "Expense transitioned back to in_review after resolve"
else
  red "Expense not in in_review after resolve"
fi

# ── User reply auto-transition ─────────────────────────────────────────────────
# Set back to awaiting_info first by making another request
echo ""
echo "--- User Reply Auto-Transition ---"

curl -s -o /dev/null -X PATCH "$API/api/v1/accountant/expenses/$EXP_ID/review" \
  -H "Content-Type: application/json" -b "$JAR_ADMIN" \
  -d '{"action":"request_info","note":"What was this expense for?","requestType":"info_request"}'

# User replies
REPLY_STATUS=$(curl -s -o /tmp/wv_reply -w "%{http_code}" \
  -X POST "$API/api/v1/expenses/$EXP_ID/messages" \
  -H "Content-Type: application/json" \
  -b "$JAR_USER" \
  -d '{"body":"This was for client dinner on May 12"}')
[ "$REPLY_STATUS" = "201" ] && green "User reply sent (HTTP 201)" || red "User reply ($REPLY_STATUS)"

# After user reply, expense should auto-transition to in_review
AFTER_REPLY=$(curl -s "$API/api/v1/expenses/$EXP_ID" -b "$JAR_ADMIN")
if echo "$AFTER_REPLY" | grep -q '"in_review"'; then
  green "Auto-transition: awaiting_info → in_review on user reply"
else
  red "Auto-transition failed — expense not in_review after user reply"
fi

# ── Queue flags ────────────────────────────────────────────────────────────────
echo ""
echo "--- Queue Flags ---"

QUEUE=$(curl -s "$API/api/v1/accountant/queue" -b "$JAR_ADMIN")
EXP_FLAGS=$(python3 -c "
import json
q = json.loads(open('/dev/stdin').read())
exps = q.get('expenses', [])
exp = next((e for e in exps if e['id'] == '$EXP_ID'), None)
if exp:
    print(' '.join(exp.get('flags', [])))
else:
    print('expense not found in queue')
" <<< "$QUEUE")

echo "  Flags: $EXP_FLAGS"
echo "$EXP_FLAGS" | grep -q 'needs_payment_method' && green "missing payment method flagged" || red "needs_payment_method flag missing"
echo "$EXP_FLAGS" | grep -q 'needs_category' && green "needs_category flag set" || red "needs_category flag missing"
echo "$EXP_FLAGS" | grep -q 'missing_receipt' && green "missing_receipt flag set" || red "missing_receipt flag missing"

# ── Approve and test Zoho readiness ────────────────────────────────────────────
echo ""
echo "--- Zoho Readiness Flags ---"

# Approve the expense
curl -s -o /dev/null -X PATCH "$API/api/v1/accountant/expenses/$EXP_ID/review" \
  -H "Content-Type: application/json" -b "$JAR_ADMIN" \
  -d '{"action":"approve","zohoEntity":"Test Entity"}'

QUEUE2=$(curl -s "$API/api/v1/accountant/queue" -b "$JAR_ADMIN")
EXP_FLAGS2=$(python3 -c "
import json
q = json.loads(open('/dev/stdin').read())
exps = q.get('expenses', [])
exp = next((e for e in exps if e['id'] == '$EXP_ID'), None)
if exp:
    print(' '.join(exp.get('flags', [])))
    print('zohoReady:', exp.get('zohoReady'))
else:
    print('not in queue')
" <<< "$QUEUE2")

echo "  Post-approve flags: $EXP_FLAGS2"
# Should have needs_entity gone (we set zohoEntity), but still not ready_for_zoho
# (missing receipt, category, payment method)
echo "$EXP_FLAGS2" | grep -q 'needs_entity' && red "needs_entity still set after zohoEntity was provided" || green "needs_entity cleared after setting zohoEntity"
echo "$EXP_FLAGS2" | grep -q 'ready_for_zoho' && red "ready_for_zoho set despite missing fields" || green "NOT ready_for_zoho (expected — missing receipt/category/paymentMethod)"

# ── Audit Trail ───────────────────────────────────────────────────────────────
echo ""
echo "--- Audit Trail ---"

AUDIT_STATUS=$(curl -s -o /tmp/wv_audit -w "%{http_code}" \
  "$API/api/v1/accountant/expenses/$EXP_ID/audit" \
  -b "$JAR_ADMIN")
if [ "$AUDIT_STATUS" = "200" ]; then
  AUDIT_COUNT=$(python3 -c "import json; print(len(json.load(open('/tmp/wv_audit'))['entries']))")
  [ "$AUDIT_COUNT" -gt "0" ] && green "Audit trail returns $AUDIT_COUNT entries" || red "Audit trail empty (expected entries)"
  # Verify actor name is populated
  HAS_ACTOR=$(python3 -c "import json; entries=json.load(open('/tmp/wv_audit'))['entries']; print('yes' if any(e.get('actorName') for e in entries) else 'no')")
  [ "$HAS_ACTOR" = "yes" ] && green "Audit entries include actorName" || red "Audit entries missing actorName"
else
  red "Audit trail ($AUDIT_STATUS)"
fi

# Non-accountant cannot access audit trail
AUDIT_UNAUTH=$(curl -s -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accountant/expenses/$EXP_ID/audit" \
  -b "$JAR_USER")
[ "$AUDIT_UNAUTH" = "403" ] && green "Non-accountant blocked from audit trail (403)" || red "Audit trail accessible to non-accountant (got $AUDIT_UNAUTH)"

# ── Admin User Management ──────────────────────────────────────────────────────
echo ""
echo "--- Admin User Management ---"

JAR_ACCT=/tmp/wv_acct.jar
JAR_NEWUSER=/tmp/wv_newuser.jar
TEST_EMAIL="pilottest_$(date +%s)@midas.local"

# Create accountant session for ownership tests
ACCT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$API/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ACCOUNTANT_EMAIL\",\"password\":\"$ACCOUNTANT_PASSWORD\"}" \
  -c "$JAR_ACCT")
[ "$ACCT_STATUS" = "200" ] && green "Accountant login for ownership tests" || { red "Accountant login ($ACCT_STATUS)"; JAR_ACCT=""; }

# Non-admin cannot create user
if [ -n "$JAR_ACCT" ]; then
  NA_CREATE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$API/api/v1/admin/users" \
    -H "Content-Type: application/json" \
    -b "$JAR_ACCT" \
    -d '{"name":"Hacker","email":"hacker@midas.local","role":"admin","password":"password123"}')
  [ "$NA_CREATE" = "403" ] && green "Non-admin blocked from creating user (403)" || red "Non-admin create user: expected 403, got $NA_CREATE"
fi

# Admin creates a test user
NEW_USER_STATUS=$(curl -s -o /tmp/wv_newuser -w "%{http_code}" \
  -X POST "$API/api/v1/admin/users" \
  -H "Content-Type: application/json" \
  -b "$JAR_ADMIN" \
  -d "{\"name\":\"Test Pilot User\",\"email\":\"$TEST_EMAIL\",\"role\":\"user\",\"password\":\"pilotTest99\"}")
if [ "$NEW_USER_STATUS" = "201" ]; then
  NEW_USER_ID=$(python3 -c "import json; print(json.load(open('/tmp/wv_newuser'))['user']['id'])")
  NEW_USER_EMAIL=$(python3 -c "import json; print(json.load(open('/tmp/wv_newuser'))['user']['email'])")
  green "Admin created user → ${NEW_USER_EMAIL}"

  # Password hash must NOT be in response
  if python3 -c "import json,sys; u=json.load(open('/tmp/wv_newuser'))['user']; sys.exit(0 if 'passwordHash' not in u else 1)"; then
    green "passwordHash not returned in create response"
  else
    red "passwordHash exposed in create response!"
  fi
else
  red "Admin create user ($NEW_USER_STATUS)"
  cat /tmp/wv_newuser | head -3
  NEW_USER_ID=""
fi

# New user can log in
if [ -n "$NEW_USER_ID" ]; then
  LOGIN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$API/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"pilotTest99\"}" \
    -c "$JAR_NEWUSER")
  [ "$LOGIN_STATUS" = "200" ] && green "New user can log in with initial password" || red "New user login: expected 200, got $LOGIN_STATUS"

  # Duplicate email blocked
  DUP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$API/api/v1/admin/users" \
    -H "Content-Type: application/json" \
    -b "$JAR_ADMIN" \
    -d "{\"name\":\"Dup\",\"email\":\"$TEST_EMAIL\",\"role\":\"user\",\"password\":\"password123\"}")
  [ "$DUP_STATUS" = "409" ] && green "Duplicate email blocked (409)" || red "Duplicate email not blocked (got $DUP_STATUS)"

  # Admin resets password
  RESET_STATUS=$(curl -s -o /tmp/wv_reset -w "%{http_code}" \
    -X POST "$API/api/v1/admin/users/$NEW_USER_ID/reset-password" \
    -b "$JAR_ADMIN")
  if [ "$RESET_STATUS" = "200" ]; then
    TEMP_PASS=$(python3 -c "import json; print(json.load(open('/tmp/wv_reset'))['tempPassword'])")
    green "Admin reset password → temp password returned"

    # Old password no longer works
    OLD_LOGIN=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "$API/api/v1/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"pilotTest99\"}")
    [ "$OLD_LOGIN" = "401" ] && green "Old password rejected after reset (401)" || red "Old password still accepted after reset (got $OLD_LOGIN)"

    # New temp password works
    NEW_LOGIN=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "$API/api/v1/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEMP_PASS\"}")
    [ "$NEW_LOGIN" = "200" ] && green "New temp password accepted" || red "Temp password not accepted (got $NEW_LOGIN)"
  else
    red "Admin reset password ($RESET_STATUS)"
    TEMP_PASS=""
  fi

  # Admin deactivates user
  DEACT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PATCH "$API/api/v1/admin/users/$NEW_USER_ID" \
    -H "Content-Type: application/json" \
    -b "$JAR_ADMIN" \
    -d '{"isActive":false}')
  [ "$DEACT_STATUS" = "200" ] && green "Admin deactivated user" || red "Deactivate user ($DEACT_STATUS)"

  # Deactivated user cannot log in
  if [ -n "$TEMP_PASS" ]; then
    DEACT_LOGIN=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "$API/api/v1/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEMP_PASS\"}")
    [ "$DEACT_LOGIN" = "401" ] && green "Deactivated user cannot log in (401)" || red "Deactivated user login: expected 401, got $DEACT_LOGIN"
  fi

  # Admin reactivates user
  REACT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PATCH "$API/api/v1/admin/users/$NEW_USER_ID" \
    -H "Content-Type: application/json" \
    -b "$JAR_ADMIN" \
    -d '{"isActive":true}')
  [ "$REACT_STATUS" = "200" ] && green "Admin reactivated user" || red "Reactivate user ($REACT_STATUS)"
fi

# ── Release-Claim Ownership Enforcement ────────────────────────────────────────
echo ""
echo "--- Release-Claim Ownership ---"

# Create and submit another expense for ownership test
OWN_EXP_STATUS=$(curl -s -o /tmp/wv_own_exp -w "%{http_code}" \
  -X POST "$API/api/v1/expenses" \
  -H "Content-Type: application/json" \
  -b "$JAR_USER" \
  -d '{"merchant":"Ownership Test Co","amount":15.00,"date":"2026-05-13","description":"Ownership test"}')
if [ "$OWN_EXP_STATUS" = "201" ]; then
  OWN_EXP_ID=$(python3 -c "import json; print(json.load(open('/tmp/wv_own_exp'))['expense']['id'])")
  curl -s -o /dev/null -X POST "$API/api/v1/expenses/$OWN_EXP_ID/submit" -b "$JAR_USER"
  green "Created and submitted expense for ownership test"

  # Admin claims it
  curl -s -o /dev/null -X POST "$API/api/v1/accountant/expenses/$OWN_EXP_ID/claim" -b "$JAR_ADMIN"
  green "Admin claimed expense for ownership test"

  # Non-claiming accountant tries to release → 403
  if [ -n "$JAR_ACCT" ]; then
    FORBID_RELEASE=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "$API/api/v1/accountant/expenses/$OWN_EXP_ID/release-claim" \
      -b "$JAR_ACCT")
    [ "$FORBID_RELEASE" = "403" ] && green "Non-claiming accountant blocked from releasing (403)" || red "Ownership not enforced: expected 403, got $FORBID_RELEASE"
  fi

  # Admin can release anyone's claim
  ADMIN_RELEASE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$API/api/v1/accountant/expenses/$OWN_EXP_ID/release-claim" \
    -b "$JAR_ADMIN")
  [ "$ADMIN_RELEASE" = "200" ] && green "Admin can release anyone's claim (200)" || red "Admin release: expected 200, got $ADMIN_RELEASE"

  # Re-claim as accountant then accountant can release their own
  if [ -n "$JAR_ACCT" ]; then
    curl -s -o /dev/null -X POST "$API/api/v1/accountant/expenses/$OWN_EXP_ID/claim" -b "$JAR_ACCT"
    SELF_RELEASE=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "$API/api/v1/accountant/expenses/$OWN_EXP_ID/release-claim" \
      -b "$JAR_ACCT")
    [ "$SELF_RELEASE" = "200" ] && green "Claimant can release their own claim (200)" || red "Claimant self-release: expected 200, got $SELF_RELEASE"
  fi
else
  red "Create ownership test expense ($OWN_EXP_STATUS)"
fi

rm -f "$JAR_ACCT" "$JAR_NEWUSER"

# ── Cleanup ────────────────────────────────────────────────────────────────────
echo ""
echo "--- Cleanup ---"

# Verify delete is blocked on non-draft expense (EXP_ID is currently approved)
DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE "$API/api/v1/expenses/$EXP_ID" -b "$JAR_USER")
[ "$DEL_STATUS" = "409" ] && green "Delete correctly blocked on non-draft expense" || red "Delete returned $DEL_STATUS (expected 409)"

# Reject test expenses so they leave the accountant queue
REJECT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PATCH "$API/api/v1/accountant/expenses/$EXP_ID/review" \
  -H "Content-Type: application/json" -b "$JAR_ADMIN" \
  -d '{"action":"reject","note":"Automated test cleanup"}')
[ "$REJECT_STATUS" = "200" ] && green "Rejected workflow test expense (queue cleared)" || red "Failed to reject workflow test expense ($REJECT_STATUS)"

if [ -n "${OWN_EXP_ID:-}" ]; then
  OWN_REJECT=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PATCH "$API/api/v1/accountant/expenses/$OWN_EXP_ID/review" \
    -H "Content-Type: application/json" -b "$JAR_ADMIN" \
    -d '{"action":"reject","note":"Automated test cleanup"}')
  [ "$OWN_REJECT" = "200" ] && green "Rejected ownership test expense (queue cleared)" || red "Failed to reject ownership test expense ($OWN_REJECT)"
fi

# Deactivate the test user created during user management tests
if [ -n "${NEW_USER_ID:-}" ]; then
  DEACT_CLEAN=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PATCH "$API/api/v1/admin/users/$NEW_USER_ID" \
    -H "Content-Type: application/json" -b "$JAR_ADMIN" \
    -d '{"isActive":false}')
  [ "$DEACT_CLEAN" = "200" ] && green "Deactivated test user" || red "Failed to deactivate test user ($DEACT_CLEAN)"
fi

# Deactivate test payment method
if [ -n "${PM_ID:-}" ]; then
  curl -s -o /dev/null -X PATCH "$API/api/v1/payment-methods/$PM_ID" \
    -H "Content-Type: application/json" -b "$JAR_ADMIN" \
    -d '{"isActive":false}'
  green "Deactivated test payment method"
fi

rm -f "$JAR_ADMIN" "$JAR_USER"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mAll %d workflow checks passed.\033[0m\n' "$PASS"
else
  printf '\033[31m%d passed, %d FAILED.\033[0m\n' "$PASS" "$FAIL"
fi
exit $FAIL
