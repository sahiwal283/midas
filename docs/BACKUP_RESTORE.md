# Midas Backup and Restore

## Overview

Two backup targets:
1. **PostgreSQL database** — `pg_dump` compressed SQL, pulled from CT 3220 (192.168.1.211)
2. **Receipt uploads** — `tar.gz` of `/opt/midas/uploads/` from CT 3120

Backups run nightly via cron on **CT 3120** (midas-app-prod, 192.168.1.210).  
Primary backup files: `/opt/midas/backups/` on CT 3120.  
Secondary copy: `/mnt/ssd2/midas-backups/` on Proxmox host (separate physical SSD).  
Retention: 14 days (primary). Secondary copy updated nightly.

> **OFFSITE REPLICATION NOT YET CONFIGURED.** Both the primary and secondary copies are on the same Proxmox host. A host-level failure or physical loss would still lose both copies. An offsite destination (NAS, cloud, PBS on a separate device) is required before this qualifies as a real backup strategy for production accounting data.

---

## Backup schedule

| Cron | Host | Time | Action |
|---|---|---|---|
| `/etc/cron.d/midas-backup` | CT 3120 | 02:00 daily | Primary: pg_dump + uploads tar |
| `/etc/cron.d/midas-backup-secondary` | Proxmox host | 02:15 daily | Secondary: pct pull to ssd2 |

---

## Manual backup run

```bash
# From Proxmox host — primary backup
pct exec 3120 -- bash /opt/midas/scripts/backup-midas.sh

# From Proxmox host — secondary copy to ssd2 (run after primary)
bash /root/scripts/midas-backup-secondary.sh
```

---

## Validate backups

```bash
# Quick status
pct exec 3120 -- bash -c '
  echo "=== Primary backup files ===" && ls -lh /opt/midas/backups/*.sql.gz /opt/midas/backups/*.tar.gz
  echo "=== Last backup log ===" && tail -5 /opt/midas/backups/backup.log
'

# Validate latest DB backup integrity
pct exec 3120 -- bash -c '
  LATEST=$(ls -t /opt/midas/backups/db_*.sql.gz | head -1)
  gzip -t "$LATEST" && echo "gzip -t PASS: $LATEST" || echo "FAIL: $LATEST"
'

# Validate latest uploads backup
pct exec 3120 -- bash -c '
  LATEST=$(ls -t /opt/midas/backups/uploads_*.tar.gz | head -1)
  tar -tzf "$LATEST" | head -5 && echo "tar -tzf PASS" || echo "FAIL"
'

# Check secondary copy on ssd2
ls -lh /mnt/ssd2/midas-backups/
tail -5 /mnt/ssd2/midas-backups/secondary-backup.log
```

---

## Restore — database

> **WARNING: Running these commands against the live database will overwrite all data. Read completely before running. Do not restore over the live DB without explicit operator approval.**

### Test restore to a temporary database (safe)

Pulls the backup file from CT 3120 to the Proxmox host first, then pipes into CT 3220.

```bash
# 1. Pull the backup file to Proxmox host
pct pull 3120 /opt/midas/backups/db_YYYYMMDD_HHMMSS.sql.gz /tmp/db_restore.sql.gz

# 2. Create a throwaway database on CT 3220
pct exec 3220 -- psql -U midas -h 127.0.0.1 -c "CREATE DATABASE midas_restore_test;"

# 3. Restore into it
gunzip -c /tmp/db_restore.sql.gz | pct exec 3220 -- psql -U midas -h 127.0.0.1 midas_restore_test

# 4. Verify
pct exec 3220 -- psql -U midas -h 127.0.0.1 midas_restore_test -c "\dt"
pct exec 3220 -- psql -U midas -h 127.0.0.1 midas_restore_test -c "SELECT COUNT(*) FROM expenses;"

# 5. Drop when done
pct exec 3220 -- psql -U midas -h 127.0.0.1 -c "DROP DATABASE midas_restore_test;"
rm /tmp/db_restore.sql.gz
```

### Full restore to live database (emergency only)

Only do this if the live database is already lost or you have explicitly decided to overwrite it.

```bash
# 1. Stop the API to prevent writes during restore
pct exec 3120 -- bash -c 'cd /opt/midas && docker compose stop api'

# 2. Pull backup to Proxmox host
pct pull 3120 /opt/midas/backups/db_YYYYMMDD_HHMMSS.sql.gz /tmp/db_restore.sql.gz

# 3. On CT 3220 — drop and recreate the database
pct exec 3220 -- psql -U postgres -h 127.0.0.1 -c "DROP DATABASE midas;"
pct exec 3220 -- psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE midas OWNER midas;"

# 4. Restore
gunzip -c /tmp/db_restore.sql.gz | pct exec 3220 -- psql -U midas -h 127.0.0.1 midas

# 5. Restart API
pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d api'

rm /tmp/db_restore.sql.gz
```

---

## Restore — uploads

```bash
# Pull backup to Proxmox host
pct pull 3120 /opt/midas/backups/uploads_YYYYMMDD_HHMMSS.tar.gz /tmp/uploads_restore.tar.gz

# Inspect contents before restoring
tar -tzf /tmp/uploads_restore.tar.gz | head -20

# Extract to a temp dir to verify
mkdir -p /tmp/uploads_check
tar -xzf /tmp/uploads_restore.tar.gz -C /tmp/uploads_check
ls /tmp/uploads_check/uploads/ | head -10

# If correct, restore (WARNING: overwrites current uploads)
pct exec 3120 -- bash -c 'rm -rf /opt/midas/uploads && mkdir -p /opt/midas/uploads'
tar -xzf /tmp/uploads_restore.tar.gz -C /tmp/uploads_check
# Then push each file or tar into CT using pct push

rm -rf /tmp/uploads_restore.tar.gz /tmp/uploads_check
```

---

## Backup file naming

| Pattern | Contents |
|---|---|
| `db_YYYYMMDD_HHMMSS.sql.gz` | Full pg_dump of the `midas` database from CT 3220 |
| `uploads_YYYYMMDD_HHMMSS.tar.gz` | Compressed tar of `/opt/midas/uploads/` |
| `backup.log` | Rolling log of all backup runs |

---

## Retention

Files older than 14 days are automatically deleted by the backup script. The deletion only matches `db_*.sql.gz` and `uploads_*.tar.gz` to prevent accidental removal of other files.

The secondary copy on ssd2 is not automatically trimmed — old files accumulate until manually cleaned. ssd2 has ~182 GB free as of 2026-05-15.

---

## Secondary copy — ssd2 (implemented 2026-05-15)

ssd2-local (`/dev/sdb`, 234 GB, separate physical SSD on Proxmox host) is used as a second local copy of all backup files. CT 3120's rootfs is on local-lvm (LVM thin), so it cannot be accessed as a directory from the Proxmox host. The secondary backup uses `pct pull` to extract files.

| Item | Value |
|---|---|
| Script | `/root/scripts/midas-backup-secondary.sh` on Proxmox host |
| Cron | `/etc/cron.d/midas-backup-secondary` (02:15 daily) |
| Destination | `/mnt/ssd2/midas-backups/` |
| Log | `/mnt/ssd2/midas-backups/secondary-backup.log` |

This provides resilience against CT 3120 filesystem corruption but **not** against Proxmox host hardware failure or physical loss.

---

## Offsite replication

Not yet configured. Both backup copies are on the same Proxmox host.

### Available options (not yet evaluated/implemented)

| Option | Notes |
|---|---|
| **Proxmox Backup Server** | Block-level, versioned CT snapshots. Best long-term solution. Requires PBS on separate device/VM. |
| **rclone to cloud** | Requires internet-accessible Proxmox host. `rclone` not yet installed. Candidate remotes: Backblaze B2, Wasabi, S3. |
| **rsync to NAS** | No NAS on 192.168.1.0/24 currently. Option D when NAS is added. |
| **rsync from CT 3120 to remote** | Requires SSH key setup in CT 3120 (`rsync` not installed there as of 2026-05-15). |

No NAS, no PBS, no remote storage is currently configured.

---

## Disk usage (checked 2026-05-15)

| Storage | Size | Free | Notes |
|---|---|---|---|
| local (Proxmox) | 67 GB | 34 GB | CT images, ISO |
| local-lvm | ~400 GB | 26 GB | **93.5% full — monitor closely** |
| ssd2-local | 234 GB | 182 GB | Secondary backup target |
| CT 3120 filesystem | 20 GB | 14 GB free | After Docker build cache prune (2026-05-15) |
| CT 3220 filesystem | 20 GB | 18 GB free | PostgreSQL data, ssd2-local storage |

**local-lvm is at 93.5% capacity** — this is Proxmox-host wide across all CTs and VMs. Monitor with `pvesm status`. CT 3120's own disk is healthy (25% used) after Docker build cache was pruned. OCR CT 9500 disk is at ~99.8% used — that's an OCR team concern, not Midas.

**Docker cleanup performed 2026-05-15 on CT 3120:**
- Removed orphaned `midas-web-test:latest` image (93 MB)
- Pruned all Docker build cache (freed 11.12 GB)
- Remaining reclaimable: `midas_pgdata` volume (46.7 MB, orphaned — no postgres container runs on CT 3120 in production). Do not remove without explicit approval.
- `postgres:16-alpine` image (395 MB) is referenced by `docker-compose.local.yml` — do not remove.

---

## Pre-production backup requirement

Before Midas handles real accounting data at production scale, all three of the following must be complete:

- [x] **Local backup validated**: `gzip -t` on latest DB backup and `tar -tzf` on latest uploads backup both pass. *(2026-05-15)*
- [ ] **Offsite backup configured**: at least one option from the table above is running and has produced a successful offsite copy.
- [x] **Restore-to-new-DB tested**: restore drill performed 2026-05-15 using `db_20260515_020001.sql.gz` into `midas_restore_verify_20260515` on CT 3220. All 9 tables present. Row counts matched live DB within expected daily delta. Temp DB dropped after verification. *(2026-05-15)*

**Remaining blocker:** offsite backup not configured. Both the primary and secondary copies are on the same Proxmox host.
