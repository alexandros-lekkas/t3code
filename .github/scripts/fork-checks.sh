#!/usr/bin/env bash
# Fork (alexandros-lekkas/t3code): the checks a boat commit must pass, on a GitHub-hosted
# ubuntu runner. Used by fork-checks.yml and by fork-sync.yml after merging an upstream release.
# Each step logs to $FORK_CHECKS_LOG_DIR/<step>.log; a summary of failed steps goes to
# $FORK_CHECKS_LOG_DIR/failed.txt. Exits non-zero when any step fails.
set -uo pipefail

log_dir="${FORK_CHECKS_LOG_DIR:-${RUNNER_TEMP:-/tmp}/fork-checks}"
rm -rf "$log_dir"
mkdir -p "$log_dir"
: >"$log_dir/failed.txt"

# The runner's trace writer can crash on surrogate pairs in test output.
ascii() { python3 -u -c 'import sys
for line in sys.stdin: sys.stdout.write(line.encode("ascii", "backslashreplace").decode("ascii"))'; }

step() {
  local name="$1"
  shift
  echo "::group::$name"
  local started=$SECONDS
  "$@" 2>&1 | ascii | tee "$log_dir/$name.log"
  local status=${PIPESTATUS[0]}
  echo "::endgroup::"
  if [[ $status -ne 0 ]]; then
    echo "::error::$name failed (exit $status, $((SECONDS - started))s)"
    echo "$name" >>"$log_dir/failed.txt"
  else
    echo "$name passed ($((SECONDS - started))s)"
  fi
}

step install vp install
step electron vp run --filter @t3tools/desktop ensure:electron
step typecheck vp run typecheck
step i18n vp run i18n:check
step lint vp check
step test-packages vp run --parallel --concurrency-limit 4 \
  --filter '!t3' --filter '!@t3tools/monorepo' --filter '!@t3tools/web' test
step test-server vp run --filter t3 test
step test-web vp run --filter @t3tools/web test

if [[ -s "$log_dir/failed.txt" ]]; then
  echo "Failed checks: $(tr '\n' ' ' <"$log_dir/failed.txt")"
  exit 1
fi
echo "All checks passed."
