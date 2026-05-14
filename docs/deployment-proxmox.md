# Proxmox Deployment Guide

## Overview

Midas is designed to run on a Proxmox LXC container using Docker Compose. No Proxmox-specific code exists in the application — the transition from local dev to Proxmox is purely infrastructure.

---

## Current State: Local Dev

Everything runs with:
```bash
cp .env.example .env
# Edit .env with real secrets
docker compose up --build
```

No Proxmox access is required. All services run locally.

---

## Proxmox Transition Checklist

When Proxmox access is restored:

### 1. Create LXC Container
- Template: Debian 12 or Ubuntu 22.04
- Specs: 2 vCPU, 4 GB RAM, 40 GB disk (ZFS-backed recommended)
- Network: static IP on your internal VLAN

### 2. Install Docker
```bash
apt update && apt install -y docker.io docker-compose-plugin
systemctl enable --now docker
```

### 3. Clone Repo and Configure
```bash
git clone <repo> /opt/midas
cd /opt/midas
cp .env.example .env
# Set real secrets: JWT_SECRET, POSTGRES_PASSWORD, ZOHO_SERVICE_URL, etc.
```

### 4. Production Docker Compose Overrides
Create `docker-compose.prod.yml` (do NOT commit secrets):
```yaml
services:
  api:
    build:
      target: prod
    restart: always

  web:
    build:
      target: prod
    restart: always

  db:
    volumes:
      - /opt/midas-data/pgdata:/var/lib/postgresql/data
```

Run with:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### 5. Nginx Reverse Proxy
Install nginx on the host (not in Docker):
```nginx
server {
    listen 80;
    server_name midas.internal;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name midas.internal;

    ssl_certificate /etc/letsencrypt/live/midas.internal/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/midas.internal/privkey.pem;

    # API
    location /api/ {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Uploads
    location /uploads/ {
        proxy_pass http://localhost:4000;
    }

    # Frontend (SPA)
    location / {
        proxy_pass http://localhost:5173;   # dev
        # Production: serve nginx static from /opt/midas/apps/web/dist
    }
}
```

### 6. Production Build
```bash
npm run build -w apps/web
# Serve apps/web/dist with nginx instead of the Vite dev server
```

### 7. Database Migrations
Switch from `db:push` to proper migrations in production:
```bash
# Generate migration files from current schema
npm run db:generate -w apps/api

# Apply migrations (safe, incremental)
docker compose exec api npm run db:migrate
```

### 8. Update COOKIE_SECURE and COOKIE_DOMAIN
```env
COOKIE_SECURE=true
COOKIE_DOMAIN=midas.internal   # or shared domain for SSO
```

### 9. Enable CORS for Internal Apps
If Argo or Milo need to hit the Midas API from a browser:
```env
CORS_ORIGIN=https://argo.internal,https://milo.internal
```

---

## File Storage

For production, consider migrating from local disk to MinIO (S3-compatible):
1. Add MinIO service to docker-compose.prod.yml
2. Set `STORAGE_MODE=s3` and configure S3 env vars
3. The `StorageAdapter` interface in `apps/api/src/lib/storage.ts` is already abstracted

---

## Backup

```bash
# Database backup
docker compose exec db pg_dump -U midas midas | gzip > /opt/backups/midas-$(date +%Y%m%d).sql.gz

# Uploads backup (if using local storage)
tar czf /opt/backups/uploads-$(date +%Y%m%d).tar.gz /opt/midas-data/uploads
```

---

## What Does NOT Need to Change

- Application code — no hardcoded IPs, no production-only assumptions
- Docker Compose structure — same services, same networking
- Environment variable names — just values change
- Migration files — already committed, run with `db:migrate`
