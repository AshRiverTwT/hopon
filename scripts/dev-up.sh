#!/usr/bin/env bash
# Dev only (Linux container): ensure Postgres and a fresh hopon-server are up.
# Every wait is bounded. Usage: scripts/dev-up.sh [--restart-server]
set -uo pipefail
cd "$(dirname "$0")/.."
PG=/usr/lib/postgresql/16/bin
if ! pg_isready -h 127.0.0.1 -q 2>/dev/null; then
  su postgres -c "$PG/pg_ctl -D /var/lib/hopon-pg/data -l /var/lib/hopon-pg/log start" >/dev/null 2>&1
  for _ in $(seq 1 50); do pg_isready -h 127.0.0.1 -q && break; sleep 0.2 2>/dev/null || python3 -c "import time; time.sleep(0.2)"; done
fi
pg_isready -h 127.0.0.1 -q || { echo "postgres failed to start"; exit 1; }
if [ "${1:-}" = "--restart-server" ]; then pkill -x hopon-server; python3 -c "import time; time.sleep(0.4)"; fi
if ! pgrep -x hopon-server >/dev/null; then
  export DATABASE_URL=postgres://postgres@127.0.0.1/hopon HOPON_JWT_SECRET=devsecret-change-me RUST_LOG=${RUST_LOG:-warn} \
    HOPON_SEND_RATE=100000 LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret-secret-secret-secret-secret
  nohup ./target/release/hopon-server > /tmp/claude-0/server.log 2>&1 &
fi
for _ in $(seq 1 100); do curl -s localhost:8080/health >/dev/null && break; python3 -c "import time; time.sleep(0.1)"; done
curl -s localhost:8080/health >/dev/null && echo "dev services up" || { echo "server failed:"; tail -5 /tmp/claude-0/server.log; exit 1; }
