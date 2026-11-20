#!/usr/bin/env bash
# Fork (alexandros-lekkas/t3code): the checks a boat commit must pass, on a GitHub-hosted
# ubuntu runner. Used by fork-checks.yml and by fork-sync.yml after merging an upstream release.
#
#   fork-checks.sh <upstream tag>
#
# Upstream tested its own release, so only what differs from that tag is tested: the Boat
# features and any conflict fixes (`check:changed` runs the tests beside and importing changed
# files). Typecheck, lint and i18n stay repo-wide; they are fast. Without an argument the base is
# the newest stable upstream tag boat contains.
# Each step logs to $FORK_CHECKS_LOG_DIR/<step>.log; failed step names go to failed.txt.
set -uo pipefail

base="${1:-$(git tag --merged HEAD --list 'v*' | grep -Ev -- '-' | sort -V | tail -1)}"
if [[ -z "$base" ]]; then
  echo "::error::No upstream release tag to compare with; fetch upstream's tags first."
  exit 1
fi
echo "Comparing with upstream $base"

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
step lint vp check
step i18n vp run i18n:check
step changed vp run check:changed "$base"

if [[ -s "$log_dir/failed.txt" ]]; then
  echo "Failed checks: $(tr '\n' ' ' <"$log_dir/failed.txt")"
  exit 1
fi
echo "All checks passed in ${SECONDS}s."
