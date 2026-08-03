#!/usr/bin/env bash
# Midas restore validation drill.
#
# WHERE IT RUNS: the Proxmox HOST (it uses `pct` to reach the CTs). Deployed copy lives at
#   /root/scripts/midas-validate-restore.sh   — run:  bash /root/scripts/midas-validate-restore.sh [--keep]
#
# WHAT IT DOES: pulls the LATEST primary DB backup from CT 3120, restores it into a TEMPORARY
# database on CT 3220 (the DB host) as the local `postgres` superuser (peer auth — no password,
# no pg_hba host rule needed), runs sanity queries, then drops the temp DB. The production
# `midas` database and live uploads are NEVER touched.
#
# Why host-side + local postgres: pg_hba on CT 3220 only authorizes the `midas` role (from
# 192.168.1.210) to connect to the `midas` database, so a remote restore into a differently
# named temp DB is rejected. Local `postgres` peer auth avoids that without changing prod config.
#
# Exit 0 = restore validated; nonzero = failure. No secrets are printed.
set -euo pipefail
export PATH="/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"

APP_CT=3120
DB_CT=3220
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { log "FAIL: $*"; exit 1; }

command -v pct >/dev/null 2>&1 || fail "pct not on PATH ($PATH)"

TMP=$(mktemp -d)
TS=$(date +%Y%m%d_%H%M%S)
TEMP_DB="midas_restore_verify_${TS}"
case "$TEMP_DB" in midas_restore_verify_*) : ;; *) fail "temp DB name guard failed";; esac

# postgres helper: run SQL/commands inside CT 3220 as the postgres superuser (local peer).
pgx()   { pct exec "$DB_CT" -- su - postgres -c "$1"; }
# psql with a query fed on stdin (avoids nested-quote hell through pct/su).
pgq()   { echo "$1" | pct exec "$DB_CT" -- su - postgres -c "psql -tAq -d $2" 2>/dev/null | tr -d '[:space:]'; }

cleanup() {
  if [ "$KEEP" = "1" ]; then log "--keep set; temp DB $TEMP_DB left on CT $DB_CT (drop manually)."; else
    if pgx "dropdb --if-exists $TEMP_DB" >/dev/null 2>&1; then log "Dropped temp DB $TEMP_DB"; else log "WARN: could not drop $TEMP_DB — drop manually."; fi
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# 1. Locate + pull the latest primary DB backup from CT 3120.
LATEST=$(pct exec "$APP_CT" -- bash -c 'ls -t /opt/midas/backups/db_*.sql.gz 2>/dev/null | head -1')
[ -n "$LATEST" ] || fail "no DB backup found on CT $APP_CT"
FNAME=$(basename "$LATEST")
log "Latest primary DB backup: $FNAME"
pct pull "$APP_CT" "$LATEST" "$TMP/$FNAME" 2>/dev/null || fail "pct pull of dump failed"

# 2. Integrity.
gzip -t "$TMP/$FNAME" || fail "gzip integrity check failed"
log "gzip integrity OK"

# 3. Create temp DB on the DB host (local postgres superuser).
pgx "createdb $TEMP_DB" || fail "createdb failed on CT $DB_CT (postgres peer auth)"
log "Created temp DB $TEMP_DB on CT $DB_CT"

# 4. Restore the dump into the temp DB (production DB untouched).
if ! gunzip -c "$TMP/$FNAME" | pct exec "$DB_CT" -- su - postgres -c "psql -v ON_ERROR_STOP=1 -q -d $TEMP_DB" >"$TMP/restore.log" 2>&1; then
  log "restore errors (tail):"; tail -8 "$TMP/restore.log" | sed 's/^/    /'
  fail "restore into temp DB failed"
fi
log "Dump restored without fatal errors."

# 5. Sanity queries against the TEMP DB only.
TABLES=$(pgq "select count(*) from information_schema.tables where table_schema='public';" "$TEMP_DB"); TABLES=${TABLES:-0}
USERS=$(pgq "select count(*) from users;" "$TEMP_DB"); USERS=${USERS:-ERR}
EXPENSES=$(pgq "select count(*) from expenses;" "$TEMP_DB"); EXPENSES=${EXPENSES:-ERR}
log "Sanity: public tables=$TABLES, users=$USERS, expenses=$EXPENSES"
{ [ "$TABLES" -ge 5 ]; } 2>/dev/null || fail "too few tables restored ($TABLES)"
{ [ "$USERS" != ERR ] && [ "$USERS" -ge 1 ]; } 2>/dev/null || fail "users table missing/empty after restore"

# 6. Uploads archive: pull latest + list + test-extract into a throwaway dir (never over live uploads).
UP=$(pct exec "$APP_CT" -- bash -c 'ls -t /opt/midas/backups/uploads_*.tar.gz 2>/dev/null | head -1')
if [ -n "$UP" ]; then
  pct pull "$APP_CT" "$UP" "$TMP/$(basename "$UP")" 2>/dev/null || fail "pct pull of uploads failed"
  tar -tzf "$TMP/$(basename "$UP")" >/dev/null 2>&1 || fail "uploads archive listing failed"
  mkdir -p "$TMP/upx"
  tar -xzf "$TMP/$(basename "$UP")" -C "$TMP/upx" 2>/dev/null \
    && log "Uploads archive OK ($(find "$TMP/upx" -type f | wc -l | tr -d ' ') files): $(basename "$UP")" \
    || log "WARN: uploads archive extracted no files (uploads dir is currently empty)"
fi

log "PASS: restore validation succeeded against $FNAME"
exit 0
