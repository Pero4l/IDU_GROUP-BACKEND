#!/usr/bin/env bash
# Throwaway local Postgres for the end-to-end tests. Never touches the real DB.
#
#   npm run test:db:start   # create + start + run all migrations
#   npm run test:e2e        # run the booking end-to-end test
#   npm run test:db:stop    # stop (add --clean to delete the data dir)
#
# Needs PostgreSQL server binaries (initdb/pg_ctl) and openssl.
set -euo pipefail

DIR="${TEST_DB_DIR:-/tmp/rentulo-test-db}"
PORT="${TEST_DB_PORT:-55432}"
URL="postgres://test@127.0.0.1:${PORT}/rentulo_test"

PG_BIN="${PG_BIN:-$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb 2>/dev/null | sort -V | tail -1)")}"
if [ ! -x "$PG_BIN/initdb" ]; then
  echo "Could not find initdb. Install PostgreSQL or set PG_BIN=/path/to/postgres/bin" >&2
  exit 1
fi

case "${1:-}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"
      "$PG_BIN/initdb" -D "$DIR/data" -U test --auth=trust >/dev/null
      # The app always connects with SSL, so the test server needs a cert.
      openssl req -new -x509 -days 3650 -nodes -subj "/CN=localhost" \
        -keyout "$DIR/data/server.key" -out "$DIR/data/server.crt" 2>/dev/null
      chmod 600 "$DIR/data/server.key"
    fi
    if ! "$PG_BIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
      "$PG_BIN/pg_ctl" -D "$DIR/data" -l "$DIR/log.txt" -w start \
        -o "-p $PORT -c unix_socket_directories='' -c ssl=on -c listen_addresses=127.0.0.1" >/dev/null
    fi
    psql "host=127.0.0.1 port=$PORT user=test dbname=postgres" -tAc \
      "SELECT 1 FROM pg_database WHERE datname='rentulo_test'" | grep -q 1 \
      || psql "host=127.0.0.1 port=$PORT user=test dbname=postgres" -qc "CREATE DATABASE rentulo_test"
    cd "$(dirname "$0")/../.."
    DATABASE_URL="$URL" DB_SSL_CA_PATH="" NODE_ENV=test npx sequelize-cli db:migrate | grep -E "migrated|ERROR" || true
    echo "Test DB ready: TEST_DATABASE_URL=$URL"
    ;;
  stop)
    "$PG_BIN/pg_ctl" -D "$DIR/data" stop >/dev/null 2>&1 || true
    [ "${2:-}" = "--clean" ] && rm -rf "$DIR"
    echo "Test DB stopped"
    ;;
  *)
    echo "usage: $0 start|stop [--clean]" >&2
    exit 1
    ;;
esac
