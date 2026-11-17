#!/usr/bin/env bash
# Runs on the server from an unpacked release: bash deploy/deploy.sh <release-id>
set -euo pipefail
REL="${1:?release id required}"
[[ "$REL" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo "Invalid release id"; exit 1; }
STATE_DIR="${EVENTEASE_DEPLOY_HOME:-$HOME}"
# Also lock the previous release's filename while transitioning installations.
exec 9>"$STATE_DIR/eventease-deploy.lock"
flock -n 9 || { echo "Another deployment is running"; exit 1; }
exec 8>"$STATE_DIR/eventeaseplus-deploy.lock"
flock -n 8 || { echo "A previous-version deployment is running"; exit 1; }
CA_FILE="${DB_CA_HOST_FILE:?set DB_CA_HOST_FILE to the trusted database CA bundle}"
ENVFILE="${EVENTEASE_ENV_FILE:-$STATE_DIR/eventease.env}"
if [ -z "${EVENTEASE_ENV_FILE:-}" ] && [ ! -f "$ENVFILE" ] && [ -f "$STATE_DIR/eventeaseplus.env" ]; then
  ENVFILE="$STATE_DIR/eventeaseplus.env"
  echo "Using the existing environment file from the previous installation."
fi
cd "$(dirname "$0")/.."
D=(sudo docker)
[ -f "$ENVFILE" ] || { echo "Missing environment file"; exit 1; }
[ -r "$CA_FILE" ] || { echo "Database CA bundle is not readable"; exit 1; }
[ "$(stat -c '%a' "$ENVFILE")" = "600" ] || { echo "Environment file must have permission 600"; exit 1; }

# Use the same file unchanged for validation, migration and application startup.
# In particular, preserve QR_SECRET so existing tickets remain verifiable.
COMMON_ENV=(--env-file "$ENVFILE" --env NODE_ENV=production --mount "type=bind,source=$CA_FILE,target=/run/certs/database-ca.pem,readonly")
PREVIOUS_IMAGE=""
for name in eventease eventeaseplus; do
  if [ "$("${D[@]}" inspect --format '{{.State.Running}}' "$name" 2>/dev/null || true)" = "true" ]; then
    if [ -n "$PREVIOUS_IMAGE" ]; then echo "Both application containers are running; resolve this before deploying."; exit 1; fi
    PREVIOUS_IMAGE="$("${D[@]}" inspect --format '{{.Image}}' "$name")"
  fi
done
if [ -z "$PREVIOUS_IMAGE" ]; then
  for tag in eventease:current eventeaseplus:current eventease:latest eventeaseplus:latest; do
    if PREVIOUS_IMAGE="$("${D[@]}" image inspect --format '{{.Id}}' "$tag" 2>/dev/null)"; then break; fi
    PREVIOUS_IMAGE=""
  done
fi
compatible() {
  [ -n "$1" ] && { [ "$("${D[@]}" image inspect --format '{{index .Config.Labels "org.eventease.security-schema"}}' "$1" 2>/dev/null || true)" = "1" ] ||
    [ "$("${D[@]}" image inspect --format '{{index .Config.Labels "org.eventeaseplus.security-schema"}}' "$1" 2>/dev/null || true)" = "1" ]; }
}
maintenance_on() { sudo touch /run/eventease-maintenance /run/eventeaseplus-maintenance; }
maintenance_off() { sudo rm -f /run/eventease-maintenance /run/eventeaseplus-maintenance; }
start() {
  # Removing both names also handles a stopped container left by an earlier attempt.
  "${D[@]}" rm -f eventease eventeaseplus >/dev/null 2>&1 || true
  "${D[@]}" run -d --name eventease --restart unless-stopped "${COMMON_ENV[@]}" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 -p 127.0.0.1:3000:3000 "$1" >/dev/null
}
healthy() { for _ in $(seq 1 30); do curl -fs http://localhost:3000/health >/dev/null && return 0; sleep 2; done; return 1; }

echo "==> Building eventease:$REL"
"${D[@]}" build -t "eventease:$REL" .
echo "==> Checking hosted configuration before maintenance"
"${D[@]}" run --rm "${COMMON_ENV[@]}" "eventease:$REL" node scripts/check-config.js

# Schema compatibility alone is insufficient: an older image may not support
# the chosen demo settings. Check that image without opening a DB connection.
ROLLBACK_READY=false
if compatible "$PREVIOUS_IMAGE"; then
  if "${D[@]}" run --rm "${COMMON_ENV[@]}" "$PREVIOUS_IMAGE" node -e 'const app=require("./src/server").createApp();app.locals.pool.end().catch(()=>{process.exitCode=1})' >/dev/null 2>&1; then
    ROLLBACK_READY=true
  else
    echo "!! Automatic rollback is unavailable: the previous image cannot use the current configuration. Keep a reviewed recovery plan ready."
  fi
else
  echo "!! Automatic rollback is unavailable: no compatible previous image was found. Keep a reviewed recovery plan ready."
fi

# Both flags work with either version of the nginx example during the rename.
maintenance_on
echo "==> Applying database migrations"
"${D[@]}" run --rm "${COMMON_ENV[@]}" "eventease:$REL" node db/migrate.js
if [ -n "$PREVIOUS_IMAGE" ]; then "${D[@]}" tag "$PREVIOUS_IMAGE" eventease:previous; fi
"${D[@]}" tag "eventease:$REL" eventease:current

echo "==> Starting new version"
# Keep start inside the conditional: a failed docker run must reach rollback.
if start eventease:current && healthy; then
  maintenance_off
  echo "==> Healthy. Deployed $REL."
  "${D[@]}" images --format '{{.Tag}}' eventease | grep -Ev '^(current|previous|latest|<none>)$' | sort -r | tail -n +6 | xargs -r -I{} "${D[@]}" rmi "eventease:{}" || true
  exit 0
fi

echo "!! New version did not start or become healthy."
if [ "$ROLLBACK_READY" = true ]; then
  echo "==> Rolling back to the previous compatible image"
  "${D[@]}" tag "$PREVIOUS_IMAGE" eventease:current
  if start "$PREVIOUS_IMAGE" && healthy; then
    maintenance_off
    echo "==> Rolled back and healthy."
  else
    echo "!! Rollback is not healthy. Maintenance remains enabled."
  fi
else
  echo "!! Automatic rollback was not verified before deployment. Maintenance remains enabled. Restore a reviewed compatible release."
fi
exit 1
