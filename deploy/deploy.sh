#!/usr/bin/env bash
# Runs ON THE SERVER as ec2-user, from an unpacked release. Usage: bash deploy/deploy.sh <release-id>
# Builds the new image, applies database migrations, swaps the container, checks health,
# and rolls back to the previous image if the new one does not become healthy.
set -euo pipefail
REL="${1:?release id required}"
[[ "$REL" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo "Invalid release id"; exit 1; }
exec 9>"$HOME/eventease-deploy.lock"
flock -n 9 || { echo "Another deployment is running"; exit 1; }
CA_FILE="${DB_CA_HOST_FILE:?set DB_CA_HOST_FILE to the trusted database CA bundle}"
ENVFILE="$HOME/eventease.env"
cd "$(dirname "$0")/.."
D="sudo docker"

[ -f "$ENVFILE" ] || { echo "Missing $ENVFILE"; exit 1; }
[ -r "$CA_FILE" ] || { echo "Database CA bundle is not readable"; exit 1; }
[ "$(stat -c '%a' "$ENVFILE")" = "600" ] || { echo "Environment file must have permission 600"; exit 1; }

# First run after the manual setup: the image is called eventease:latest. Keep it as the rollback point.
if ! $D image inspect eventease:current >/dev/null 2>&1; then
  $D image inspect eventease:latest >/dev/null 2>&1 && $D tag eventease:latest eventease:current || true
fi

echo "==> Building eventease:$REL"
$D build -t "eventease:$REL" .

# The supplied nginx configuration observes this flag. Keep maintenance enabled on failures.
sudo touch /run/eventease-maintenance
echo "==> Applying database migrations"
$D run --rm --env-file "$ENVFILE" --mount "type=bind,source=$CA_FILE,target=/run/certs/database-ca.pem,readonly" "eventease:$REL" node db/migrate.js

if $D image inspect eventease:current >/dev/null 2>&1; then $D tag eventease:current eventease:previous; fi
$D tag "eventease:$REL" eventease:current

start() { $D rm -f eventease >/dev/null 2>&1 || true; $D run -d --name eventease --restart unless-stopped --env-file "$ENVFILE" --mount "type=bind,source=$CA_FILE,target=/run/certs/database-ca.pem,readonly" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 -p 127.0.0.1:3000:3000 "$1" >/dev/null; }
healthy() { for _ in $(seq 1 30); do curl -fs http://localhost:3000/health >/dev/null && return 0; sleep 2; done; return 1; }

echo "==> Starting new version"
start eventease:current
if healthy; then
  sudo rm -f /run/eventease-maintenance
  echo "==> Healthy. Deployed $REL."
  # keep the 5 newest release images
  $D images --format '{{.Tag}}' eventease | grep -Ev '^(current|previous|latest|<none>)$' | sort -r | tail -n +6 | xargs -r -I{} $D rmi "eventease:{}" || true
  exit 0
fi

echo "!! New version did not become healthy. Logs:"; $D logs --tail 40 eventease || true
if $D image inspect eventease:previous >/dev/null 2>&1 && [ "$($D image inspect --format '{{index .Config.Labels "org.eventease.security-schema"}}' eventease:previous)" = "1" ]; then
  echo "==> Rolling back to the previous version"
  $D tag eventease:previous eventease:current
  start eventease:current
  if healthy; then sudo rm -f /run/eventease-maintenance; echo "==> Rolled back and healthy."; else echo "!! Rollback is not healthy either. Maintenance remains enabled."; fi
else
  echo "!! Automatic rollback refused: previous image does not support the hardened schema. Restore a reviewed compatible release."
fi
exit 1
