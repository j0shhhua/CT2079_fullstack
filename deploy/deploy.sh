#!/usr/bin/env bash
# Runs ON THE SERVER as ec2-user, from an unpacked release. Usage: bash deploy/deploy.sh <release-id>
# Builds the new image, applies database migrations, swaps the container, checks health,
# and rolls back to the previous image if the new one does not become healthy.
set -euo pipefail
REL="${1:?release id required}"
[[ "$REL" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo "Invalid release id"; exit 1; }
exec 9>"$HOME/eventeaseplus-deploy.lock"
flock -n 9 || { echo "Another deployment is running"; exit 1; }
CA_FILE="${DB_CA_HOST_FILE:?set DB_CA_HOST_FILE to the trusted database CA bundle}"
ENVFILE="$HOME/eventeaseplus.env"
cd "$(dirname "$0")/.."
D="sudo docker"

[ -f "$ENVFILE" ] || { echo "Missing $ENVFILE"; exit 1; }
[ -r "$CA_FILE" ] || { echo "Database CA bundle is not readable"; exit 1; }
[ "$(stat -c '%a' "$ENVFILE")" = "600" ] || { echo "Environment file must have permission 600"; exit 1; }

# First run after the manual setup: the image is called eventeaseplus:latest. Keep it as the rollback point.
if ! $D image inspect eventeaseplus:current >/dev/null 2>&1; then
  $D image inspect eventeaseplus:latest >/dev/null 2>&1 && $D tag eventeaseplus:latest eventeaseplus:current || true
fi

echo "==> Building eventeaseplus:$REL"
$D build -t "eventeaseplus:$REL" .

# The supplied nginx configuration observes this flag. Keep maintenance enabled on failures.
sudo touch /run/eventeaseplus-maintenance
echo "==> Applying database migrations"
$D run --rm --env-file "$ENVFILE" --mount "type=bind,source=$CA_FILE,target=/run/certs/database-ca.pem,readonly" "eventeaseplus:$REL" node db/migrate.js

if $D image inspect eventeaseplus:current >/dev/null 2>&1; then $D tag eventeaseplus:current eventeaseplus:previous; fi
$D tag "eventeaseplus:$REL" eventeaseplus:current

start() { $D rm -f eventeaseplus >/dev/null 2>&1 || true; $D run -d --name eventeaseplus --restart unless-stopped --env-file "$ENVFILE" --mount "type=bind,source=$CA_FILE,target=/run/certs/database-ca.pem,readonly" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 -p 127.0.0.1:3000:3000 "$1" >/dev/null; }
healthy() { for _ in $(seq 1 30); do curl -fs http://localhost:3000/health >/dev/null && return 0; sleep 2; done; return 1; }

echo "==> Starting new version"
start eventeaseplus:current
if healthy; then
  sudo rm -f /run/eventeaseplus-maintenance
  echo "==> Healthy. Deployed $REL."
  # keep the 5 newest release images
  $D images --format '{{.Tag}}' eventeaseplus | grep -Ev '^(current|previous|latest|<none>)$' | sort -r | tail -n +6 | xargs -r -I{} $D rmi "eventeaseplus:{}" || true
  exit 0
fi

echo "!! New version did not become healthy. Logs:"; $D logs --tail 40 eventeaseplus || true
if $D image inspect eventeaseplus:previous >/dev/null 2>&1 && [ "$($D image inspect --format '{{index .Config.Labels "org.eventeaseplus.security-schema"}}' eventeaseplus:previous)" = "1" ]; then
  echo "==> Rolling back to the previous version"
  $D tag eventeaseplus:previous eventeaseplus:current
  start eventeaseplus:current
  if healthy; then sudo rm -f /run/eventeaseplus-maintenance; echo "==> Rolled back and healthy."; else echo "!! Rollback is not healthy either. Maintenance remains enabled."; fi
else
  echo "!! Automatic rollback refused: previous image does not support the hardened schema. Restore a reviewed compatible release."
fi
exit 1
