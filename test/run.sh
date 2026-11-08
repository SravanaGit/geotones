#!/bin/zsh
# Runs the backend tests on a throwaway Postgres, then deletes it.
# Does not touch any other database on this machine.
set -euo pipefail
export LC_ALL=en_US.UTF-8

root=${0:A:h:h}
# Applies every migration in order, or only the files given as arguments.
migrations=(${@:-$root/supabase/migrations/*.sql(on)})
work=$(mktemp -d)
port=54329

cleanup() {
  pg_ctl -D "$work/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

initdb -D "$work/data" -A trust -U postgres >/dev/null
pg_ctl -D "$work/data" -w -l "$work/log" \
  -o "-p $port -k $work -c listen_addresses=''" start >/dev/null

run() { psql -h "$work" -p "$port" -U postgres -d postgres -q -v ON_ERROR_STOP=1 "$@"; }

run -f "$root/test/supabase_stub.sql"
for migration in $migrations; do run -f "$migration"; done
output=$(run -f "$root/test/tests.sql" 2>&1) || { print -r -- "$output"; print "TESTS CRASHED"; exit 1; }

print -r -- "$output" | grep -E 'NOTICE:  (not )?ok' | sed 's/.*NOTICE:  //' | grep '^not ok' || true
passed=$(print -r -- "$output" | grep -c 'NOTICE:  ok' || true)
failed=$(print -r -- "$output" | grep -c 'NOTICE:  not ok' || true)
print "passed: $passed  failed: $failed"
[[ $failed -eq 0 && $passed -gt 0 ]]
