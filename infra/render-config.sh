#!/usr/bin/env sh
# Render LiveKit/coturn configs from infra/.env into infra/generated/.
set -eu
cd "$(dirname "$0")"
[ -f .env ] || { echo "copy .env.example to .env and edit it first" >&2; exit 1; }
set -a; . ./.env; set +a
mkdir -p generated
# coturn needs the public IPv4 when the machine is behind NAT (cloud VMs).
ext="${TURN_EXTERNAL_IP:-$TURN_HOST}"
if printf '%s' "$ext" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  EXTERNAL_IP_LINE="external-ip=$ext"
else
  EXTERNAL_IP_LINE="# external-ip not set (TURN_EXTERNAL_IP is not an IPv4 address)"
fi
for f in livekit.yaml turnserver.conf; do
  sed -e "s|@TURN_HOST@|${TURN_HOST}|g" \
      -e "s|@TURN_PASSWORD@|${TURN_PASSWORD}|g" \
      -e "s|@LIVEKIT_API_KEY@|${LIVEKIT_API_KEY}|g" \
      -e "s|@LIVEKIT_API_SECRET@|${LIVEKIT_API_SECRET}|g" \
      -e "s|@USE_EXTERNAL_IP@|${USE_EXTERNAL_IP:-true}|g" \
      -e "s|@EXTERNAL_IP_LINE@|${EXTERNAL_IP_LINE}|g" \
      "$f.tmpl" > "generated/$f"
done
chmod 600 generated/*
echo "rendered infra/generated/livekit.yaml and turnserver.conf"
