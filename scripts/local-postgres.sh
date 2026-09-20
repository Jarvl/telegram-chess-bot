#!/usr/bin/env bash
# Start or stop a throwaway PostgreSQL 16 for integration tests.
#   scripts/local-postgres.sh start   -> prints the TEST_DATABASE_URL to export
#   scripts/local-postgres.sh stop
set -euo pipefail

PORT="${PGPORT_LOCAL:-54329}"
DIR="${PGDIR_LOCAL:-/tmp/group-chess-pg}"
BIN="${PGBIN:-$(ls -d /usr/lib/postgresql/16/bin 2>/dev/null || dirname "$(command -v pg_ctl)")}"
DB="group_chess_test"

run_as_pg() {
  if [ "$(id -u)" = "0" ]; then su postgres -s /bin/bash -c "$1"; else bash -c "$1"; fi
}

case "${1:-}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"
      [ "$(id -u)" = "0" ] && chown postgres "$DIR"
      run_as_pg "'$BIN/initdb' -D '$DIR/data' -A trust -U postgres >'$DIR/initdb.log' 2>&1"
    fi
    run_as_pg "'$BIN/pg_ctl' -D '$DIR/data' -o '-p $PORT -k $DIR -c listen_addresses=127.0.0.1' -l '$DIR/pg.log' start >/dev/null"
    for _ in $(seq 1 30); do
      "$BIN/pg_isready" -h 127.0.0.1 -p "$PORT" -U postgres >/dev/null 2>&1 && break
      sleep 0.5
    done
    "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -tAc "select 1 from pg_database where datname='$DB'" | grep -q 1 \
      || "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -qc "create database $DB"
    echo "export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/$DB"
    ;;
  stop)
    run_as_pg "'$BIN/pg_ctl' -D '$DIR/data' stop >/dev/null" || true
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
