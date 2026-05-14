#!/usr/bin/env bash
# Midas backup script — runs on CT 3120 (midas-app-prod).
# Backs up: PostgreSQL database (via pg_dump) + receipt uploads.
#
# Schedule: daily via cron (see /etc/cron.d/midas-backup).
# Retention: 14 days (local). Offsite replication is NOT YET CONFIGURED — see docs/BACKUP_RESTORE.md.
#
# Manual run:
#   bash /opt/midas/scripts/backup-midas.sh
#
# Restore:
#   See docs/BACKUP_RESTORE.md — do NOT run restore commands against the live DB without reading that doc first.

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

ENV_FILE="/opt/midas/.env"
BACKUP_DIR="/opt/midas/backups"
LOG_FILE="/opt/midas/backups/backup.log"
RETENTION_DAYS=14
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# ── Setup ─────────────────────────────────────────────────────────────────────

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "=== Midas backup started ==="

# ── Load DATABASE_URL from .env ───────────────────────────────────────────────

if [ ! -f "$ENV_FILE" ]; then
  log "ERROR: .env not found at $ENV_FILE"
  exit 1
fi

# Extract DATABASE_URL — handle quoted and unquoted values
DATABASE_URL=$(grep "^DATABASE_URL=" "$ENV_FILE" | head -1 | sed 's/^DATABASE_URL=//' | tr -d '"'"'" | tr -d "'")

if [ -z "$DATABASE_URL" ]; then
  log "ERROR: DATABASE_URL not found in $ENV_FILE"
  exit 1
fi

# ── Database backup ───────────────────────────────────────────────────────────

DB_FILE="$BACKUP_DIR/db_${TIMESTAMP}.sql.gz"

log "Starting database backup → $DB_FILE"

if PGPASSWORD=$(echo "$DATABASE_URL" | sed 's|.*://[^:]*:\([^@]*\)@.*|\1|') \
  pg_dump "$DATABASE_URL" \
  | gzip -9 > "$DB_FILE"; then
  DB_SIZE=$(du -sh "$DB_FILE" | cut -f1)
  log "Database backup complete: $DB_FILE ($DB_SIZE)"
else
  log "ERROR: Database backup failed"
  rm -f "$DB_FILE"
  exit 1
fi

# Verify non-empty
if [ ! -s "$DB_FILE" ]; then
  log "ERROR: Database backup file is empty"
  rm -f "$DB_FILE"
  exit 1
fi

# ── Uploads backup ────────────────────────────────────────────────────────────

UPLOADS_DIR="/opt/midas/uploads"
UPLOADS_FILE="$BACKUP_DIR/uploads_${TIMESTAMP}.tar.gz"

if [ -d "$UPLOADS_DIR" ]; then
  log "Starting uploads backup → $UPLOADS_FILE"
  tar -czf "$UPLOADS_FILE" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")" 2>>"$LOG_FILE"
  UPLOADS_SIZE=$(du -sh "$UPLOADS_FILE" | cut -f1)
  log "Uploads backup complete: $UPLOADS_FILE ($UPLOADS_SIZE)"
else
  log "WARNING: Uploads directory not found at $UPLOADS_DIR — skipping"
fi

# ── Retention ────────────────────────────────────────────────────────────────
# Only delete files that match the backup naming pattern to avoid accidents.

log "Applying $RETENTION_DAYS-day retention policy"
DELETED=0

find "$BACKUP_DIR" -maxdepth 1 -name 'db_*.sql.gz' -mtime "+${RETENTION_DAYS}" | while read -r f; do
  log "  Removing old DB backup: $f"
  rm -f "$f"
  (( DELETED++ )) || true
done

find "$BACKUP_DIR" -maxdepth 1 -name 'uploads_*.tar.gz' -mtime "+${RETENTION_DAYS}" | while read -r f; do
  log "  Removing old uploads backup: $f"
  rm -f "$f"
  (( DELETED++ )) || true
done

# ── Summary ───────────────────────────────────────────────────────────────────

BACKUP_COUNT=$(find "$BACKUP_DIR" -maxdepth 1 \( -name 'db_*.sql.gz' -o -name 'uploads_*.tar.gz' \) | wc -l)
log "Backup complete. $BACKUP_COUNT backup files in $BACKUP_DIR"
log "=== Midas backup finished ==="

# OFFSITE REPLICATION: not yet configured.
# When a NAS or remote destination is available, add an rsync/rclone step here.
# Example (rsync to NAS):
#   rsync -az --delete "$BACKUP_DIR/" nas:/backups/midas/
