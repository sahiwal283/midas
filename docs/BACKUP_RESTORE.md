# Midas Backup and Restore

## Overview

Two backup targets:
1. **PostgreSQL database** — `pg_dump` compressed SQL
2. **Receipt uploads** — `tar.gz` of `/opt/midas/uploads/`

Backups run nightly via cron on **CT 3120** (midas-app-prod, 192.168.1.210).
Backup files are stored locally at `/opt/midas/backups/`.
Retention: 14 days.

> **OFFSITE REPLICATION NOT YET CONFIGURED.** Local-only backups mean a CT 3120 disk failure loses both the app and its backups. An rsync/rclone step to a NAS or second Proxmox node must be added before this is considered a real backup strategy.

---

## Backup schedule

Cron file: `/etc/cron.d/midas-backup` on CT 3120.

```
# Run at 02:00 daily
0 2 * * * root bash /opt/midas/scripts/backup-midas.sh
```

---

## Manual backup run

```bash
# From Proxmox host:
pct exec 3120 -- bash /opt/midas/scripts/backup-midas.sh

# Or from inside CT 3120:
bash /opt/midas/scripts/backup-midas.sh
```

---

## Verify backups exist

```bash
pct exec 3120 -- bash -c '
  ls -lh /opt/midas/backups/
  echo "--- Last DB backup ---"
  ls -t /opt/midas/backups/db_*.sql.gz | head -1
  echo "--- Last uploads backup ---"
  ls -t /opt/midas/backups/uploads_*.tar.gz | head -1
  echo "--- Backup log (last 10 lines) ---"
  tail -10 /opt/midas/backups/backup.log
'
```

---

## Restore — database

> **WARNING: Running these commands against the live database will overwrite all data. Read completely before running.**

### Test restore to a temporary database (safe — does not touch live DB)

```bash
# On CT 3220 or any host with psql access:
BACKUP_FILE=/opt/midas/backups/db_YYYYMMDD_HHMMSS.sql.gz

# Create a throwaway database to test the restore
psql -U midas -h 192.168.1.211 -c "CREATE DATABASE midas_restore_test;"

# Restore into it
gunzip -c "$BACKUP_FILE" | psql -U midas -h 192.168.1.211 midas_restore_test

# Verify tables and row counts
psql -U midas -h 192.168.1.211 midas_restore_test -c "\dt"
psql -U midas -h 192.168.1.211 midas_restore_test -c "SELECT COUNT(*) FROM expenses;"

# Drop the test database when done
psql -U midas -h 192.168.1.211 -c "DROP DATABASE midas_restore_test;"
```

### Full restore to live database (emergency only)

Only do this if the live database is already lost or you have explicitly decided to overwrite it.

```bash
# 1. Stop the application to prevent writes during restore
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.prod.yml stop api

# 2. On CT 3220 — drop and recreate the database
pct exec 3220 -- psql -U midas -c "DROP DATABASE midas;"
pct exec 3220 -- psql -U midas -c "CREATE DATABASE midas;"

# 3. Restore from backup
BACKUP_FILE=/opt/midas/backups/db_YYYYMMDD_HHMMSS.sql.gz
gunzip -c "$BACKUP_FILE" | pct exec 3220 -- psql -U midas midas

# 4. Restart the application
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.prod.yml start api
```

---

## Restore — uploads

```bash
# List available backups
ls -lh /opt/midas/backups/uploads_*.tar.gz

# Extract to a temp location first to inspect
tar -tzf /opt/midas/backups/uploads_YYYYMMDD_HHMMSS.tar.gz | head -20

# Restore to a temp dir for inspection
tar -xzf /opt/midas/backups/uploads_YYYYMMDD_HHMMSS.tar.gz -C /tmp/

# If confirmed correct, replace the uploads directory
# WARNING: this overwrites current uploads
rsync -av --delete /tmp/uploads/ /opt/midas/uploads/
```

---

## Backup file naming

| Pattern | Contents |
|---|---|
| `db_YYYYMMDD_HHMMSS.sql.gz` | Full pg_dump of the `midas` database |
| `uploads_YYYYMMDD_HHMMSS.tar.gz` | Compressed tar of `/opt/midas/uploads/` |
| `backup.log` | Rolling log of all backup runs |

---

## Retention

Files older than 14 days are automatically deleted by the backup script.
The deletion only matches `db_*.sql.gz` and `uploads_*.tar.gz` to prevent accidental removal of other files in the backup directory.

---

## Offsite replication

Local-only backups are a starting point, not a complete backup strategy. A CT 3120 disk failure would lose both the app and its backups. Current Proxmox storage inventory (inspected 2026-05-08):

| Name | Type | Path | Free | Backup-capable |
|---|---|---|---|---|
| local | dir | /var/lib/vz | ~37 GB | Yes |
| local-lvm | lvmthin | (LVM pool) | ~43 GB | For VM images only |
| ssd2-local | dir | /mnt/ssd2 | ~187 GB | **Yes — second physical disk** |

No NAS, no PBS, no remote storage is currently configured.

### Recommended: use ssd2-local as a second local copy (immediate, zero config needed)

`/mnt/ssd2` is a separate physical SSD (ext4, 14.66% used). A copy there is not offsite but survives individual filesystem corruption and is immediately available:

```bash
# Add to end of /opt/midas/scripts/backup-midas.sh:
SECONDARY_BACKUP_DIR="/mnt/ssd2/midas-backups"
mkdir -p "$SECONDARY_BACKUP_DIR"
rsync -a --delete "$BACKUP_DIR/" "$SECONDARY_BACKUP_DIR/"
log "Secondary copy synced to $SECONDARY_BACKUP_DIR"
```

Note: this copies from inside CT 3120 to the Proxmox host's `/mnt/ssd2`. This requires the path to be bind-mounted into CT 3120, or the copy must run directly on the Proxmox host.

**Simpler path:** run a separate cron on the Proxmox host that copies from CT 3120's backup dir:
```bash
# On Proxmox host — /etc/cron.d/midas-backup-secondary
15 2 * * * root rsync -a /var/lib/lxd/storage-pools/default/containers/3120/rootfs/opt/midas/backups/ /mnt/ssd2/midas-backups/
```
(Adjust the LXC rootfs path for your Proxmox storage layout.)

### Option B — Proxmox Backup Server (PBS)

PBS provides block-level deduplication and versioned CT snapshots. Install in a new VM/CT or on an external device. Once configured, add the CT 3120 and CT 3220 VMs to a PBS backup job. This is the cleanest long-term solution for the whole Proxmox node.

### Option C — rclone to cloud (requires internet-accessible Proxmox host)

```bash
# Install rclone on Proxmox host, configure a remote (Backblaze B2 / Wasabi / S3)
rclone config  # then:
# Add to backup-midas.sh or a separate cron:
rclone sync /opt/midas/backups/ b2:my-bucket/midas-backups/ --transfers 2
```
CT 3120 has confirmed internet access as of 2026-05-08.

### Option D — rsync to NAS

When a NAS is added to the 192.168.1.0/24 network:
```bash
# Requires SSH key auth from CT 3120 to NAS, or NFS mount
rsync -az --delete /opt/midas/backups/ nas-host:/volume1/backups/midas/
```

---

## Backup status check

```bash
# Quick status: last backup time, count, log tail
pct exec 3120 -- bash -c '
  echo "=== Backup files ===" && ls -lh /opt/midas/backups/*.gz /opt/midas/backups/*.tar.gz 2>/dev/null
  echo "=== Last backup log ===" && tail -5 /opt/midas/backups/backup.log
'
```
