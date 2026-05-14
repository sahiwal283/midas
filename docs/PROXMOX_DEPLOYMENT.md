# Midas — Proxmox Deployment

## Architecture

Two separate LXC containers on the 192.168.1.0/24 LAN:

| Container | CT ID | Hostname | IP | Storage | Purpose |
|-----------|-------|----------|----|---------|---------|
| midas-app-prod | 3120 | midas-app-prod | 192.168.1.210 | local-lvm (20 GB) | Docker + API + Frontend |
| midas-db-prod | 3220 | midas-db-prod | 192.168.1.211 | ssd2-local (20 GB) | PostgreSQL 15 |

PostgreSQL is **not exposed to the public network**. Only 192.168.1.210 (midas-app-prod) has access via pg_hba.conf.

---

## Container Specs

Both containers: Debian 12, 2 vCPU, 2 GB RAM, unprivileged.

`midas-app-prod` has `features nesting=1,keyctl=1` for Docker-inside-LXC.

---

## Initial Setup Checklist

### First deploy (already completed)

```bash
# On midas-db-prod: PostgreSQL is installed and running
systemctl status postgresql

# On midas-app-prod: Docker is installed and running
docker --version
docker compose version

# Midas source is at /opt/midas
ls /opt/midas/
```

### Env file (on midas-app-prod)

The production env file lives at `/opt/midas/.env` (mode 600, root-only).
It is **never committed to git**. See `docs/ENVIRONMENT.md` for the full variable reference.

---

## Deployment

### First-time setup

```bash
# SSH into midas-app-prod
ssh root@192.168.1.210

cd /opt/midas

# 1. Run migrations + seed
docker compose -f docker-compose.prod.yml run --rm migrator

# 2. Start services
docker compose -f docker-compose.prod.yml up -d api web

# 3. Check health
curl -s http://localhost:4000/api/v1/health
curl -sf http://localhost:5173/ | head -3
```

### Subsequent deploys (after code changes)

```bash
# Push updated code to the container (from dev machine):
cd /path/to/midas
tar czf - --exclude=node_modules --exclude=.git --exclude=extension/dist \
  --exclude=apps/web/dist --exclude=apps/api/dist . | \
  ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && tar xzf -'"

# On midas-app-prod:
cd /opt/midas
docker compose -f docker-compose.prod.yml build
# If schema changed:
docker compose -f docker-compose.prod.yml run --rm migrator
docker compose -f docker-compose.prod.yml up -d api web
```

### Check running containers

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f web
```

---

## Access

- **Frontend**: http://192.168.1.210:5173
- **API health**: http://192.168.1.210:4000/api/v1/health
- **Database**: 192.168.1.211:5432 (LAN only, midas user)

Seed credentials are rotated on first deploy using `scripts/rotate-credentials.sh`. New credentials
are stored in `/root/midas-credentials.json` on CT 3120 (chmod 600, never committed to git).

Retrieve once and store in a password manager:
```bash
pct exec 3120 -- cat /root/midas-credentials.json
# Then delete the file:
pct exec 3120 -- rm /root/midas-credentials.json
```

---

## Nginx Reverse Proxy (NPM)

Not yet configured. The app is accessible on the LAN by IP only.

When ready to add a hostname/HTTPS:
1. Add a Proxy Host in NPM pointing to `192.168.1.210:5173`
2. Update `CORS_ORIGIN` in `/opt/midas/.env` to the public URL
3. Set `COOKIE_SECURE=true` in `.env`
4. Restart API: `docker compose -f docker-compose.prod.yml restart api`

---

## Uploads

Receipt files are stored at `/opt/midas/uploads/` on midas-app-prod and bind-mounted into the API container. This directory is persistent across container restarts and image rebuilds.

Backup this directory along with the database. See `docs/BACKUP_RESTORE.md`.

---

## Restart Policy

Both services use `restart: always`. They start automatically after container reboot.

The containers themselves are configured with `onboot: 1` in Proxmox.

Order on Proxmox node reboot:
1. CT 3220 starts first (order=1, up=10 seconds)
2. CT 3120 starts second (order=2, up=30 seconds)

This ordering is already configured via `pct set`.

### Known: static ARP entry for CT 3220

CT 3120 must have a correct ARP entry for 192.168.1.211 (CT 3220). A stale wrong-MAC ARP entry
silently breaks DB connectivity — packets route to the wrong destination with no TCP error, just
indefinite hangs.

**Permanent fix installed:** `/etc/network/if-up.d/midas-arp-fix` on CT 3120 runs:
```
ip neigh replace 192.168.1.211 lladdr bc:24:11:9c:4a:ec dev eth0 nud permanent
```
on `eth0` bring-up, overriding any ARP poisoning from other LAN devices.

**Root cause (May 2026 incident):** A physical LAN device with MAC `42:ff:53:ad:fd:9c` (visible on
bridge `vmbr0` via `enp2s0`, the Proxmox host's uplink) was responding to ARP requests for
192.168.1.211. This caused CT 3120's kernel to cache the wrong MAC. All DB frames were sent to a
nonexistent bridge port and silently dropped. The API started but every DB query hung until
connection timeout. Symptoms: both containers reported unhealthy, Docker Hub DNS lookups inside
containers also failed (all LAN traffic affected, not just DB).

**That device is still present on the LAN.** If it ever re-acquires 192.168.1.211 (e.g., via DHCP),
the conflict returns. Recommended mitigations:
- Assign static DHCP reservations for the entire `192.168.1.21x` range on the router so no
  unknown device can claim those addresses.
- Alternatively, set `pg_hba.conf` to reject connections not from the expected MAC (not supported
  natively; use firewall rules if needed).
- The permanent ARP entry means this device cannot poison CT 3120's cache even if it claims the IP,
  so day-to-day operations are protected.

**If CT 3220 is ever rebuilt with a new MAC address**, get the new MAC:
```bash
pct exec 3220 -- cat /sys/class/net/eth0/address
```
Then update `/etc/network/if-up.d/midas-arp-fix` on CT 3120 with the new MAC and run:
```bash
pct exec 3120 -- ip neigh replace 192.168.1.211 lladdr <NEW_MAC> dev eth0 nud permanent
```

If DB connectivity breaks mysteriously, check CT 3120's ARP table first:
```bash
pct exec 3120 -- ip neigh show | grep 192.168.1.211
# Should show: 192.168.1.211 dev eth0 lladdr bc:24:11:9c:4a:ec PERMANENT
```
