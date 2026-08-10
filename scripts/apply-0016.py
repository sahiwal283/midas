#!/usr/bin/env python3
"""Apply 0016_audit_immutable.sql on CT 3120."""
from pathlib import Path
import subprocess
import sys

env = {}
for line in Path("/opt/midas/.env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k] = v.strip().strip("\"'")

url = env.get("DATABASE_URL")
if not url:
    print("no DATABASE_URL", file=sys.stderr)
    sys.exit(1)

sql_path = Path("/opt/midas/apps/api/drizzle/0016_audit_immutable.sql")
sql = sql_path.read_text()
proc = subprocess.run(
    ["docker", "run", "--rm", "-i", "--network", "host", "postgres:15", "psql", url, "-v", "ON_ERROR_STOP=1"],
    input=sql.encode(),
    capture_output=True,
)
sys.stdout.write(proc.stdout.decode())
if proc.returncode != 0:
    sys.stderr.write(proc.stderr.decode())
    sys.exit(proc.returncode)

rec = """
CREATE TABLE IF NOT EXISTS midas_sql_migrations (
  id text PRIMARY KEY,
  applied_at timestamp NOT NULL DEFAULT now()
);
INSERT INTO midas_sql_migrations (id) VALUES ('0016_audit_immutable') ON CONFLICT DO NOTHING;
SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass ORDER BY 1;
"""
proc2 = subprocess.run(
    ["docker", "run", "--rm", "-i", "--network", "host", "postgres:15", "psql", url, "-v", "ON_ERROR_STOP=1"],
    input=rec.encode(),
    capture_output=True,
)
sys.stdout.write(proc2.stdout.decode())
if proc2.returncode != 0:
    sys.stderr.write(proc2.stderr.decode())
    sys.exit(proc2.returncode)

print("MIGRATION_0016_OK")
