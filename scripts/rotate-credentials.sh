#!/usr/bin/env bash
# Rotate Midas seed/admin credentials.
# Runs INSIDE CT 3120 (requires Docker and /opt/midas/.env to exist).
#
# Usage:
#   bash /opt/midas/scripts/rotate-credentials.sh
#
# Output: /root/midas-credentials.json (chmod 600, never leaves this CT)
# The file contains plaintext new passwords — read once, store in your password manager, then delete.

set -euo pipefail
HISTFILE=/dev/null

ENV_FILE="/opt/midas/.env"
CREDS_FILE="/root/midas-credentials.json"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

# Find the running API container
API_CONTAINER=$(docker ps --filter "name=midas.*api" --format "{{.Names}}" | head -1)
if [ -z "$API_CONTAINER" ]; then
  echo "ERROR: No running midas API container found" >&2
  exit 1
fi

echo "Using container: $API_CONTAINER"

# Extract DATABASE_URL from .env
DATABASE_URL=$(grep "^DATABASE_URL=" "$ENV_FILE" | head -1 | sed 's/^DATABASE_URL=//' | tr -d '"')

# Run rotation script inside the API container (has bcryptjs + pg)
# Stdout is captured to CREDS_FILE — passwords never appear in terminal
docker exec \
  -e DATABASE_URL="$DATABASE_URL" \
  "$API_CONTAINER" \
  node -e "
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const emails = [
  'admin@midas.local',
  'accountant@midas.local',
  'user@midas.local',
];
const creds = {};

(async () => {
  for (const email of emails) {
    const password = crypto.randomBytes(18).toString('base64url');
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'UPDATE users SET password_hash = \$1, updated_at = NOW() WHERE email = \$2 RETURNING id',
      [hash, email]
    );
    if (result.rowCount === 0) throw new Error('User not found: ' + email);
    creds[email] = password;
  }
  await pool.end();
  // Write to stdout — caller redirects to file
  process.stdout.write(JSON.stringify(creds, null, 2) + '\n');
})().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
" > "$CREDS_FILE" 2>/tmp/creds_rotate_error.log

if [ $? -ne 0 ]; then
  echo "ERROR: Rotation failed. See /tmp/creds_rotate_error.log" >&2
  cat /tmp/creds_rotate_error.log >&2
  exit 1
fi

chmod 600 "$CREDS_FILE"

echo "Done. New credentials written to $CREDS_FILE (chmod 600)."
echo "READ ONCE and store in your password manager:"
echo ""
echo "  cat $CREDS_FILE"
echo ""
echo "Then delete the file:"
echo "  rm $CREDS_FILE"
