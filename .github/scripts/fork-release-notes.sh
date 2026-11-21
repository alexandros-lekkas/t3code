#!/usr/bin/env bash
# Release notes for a fork release: the upstream release it brings in (if any) and the Boat
# commits since the previous fork release, in the generated-summary shape the desktop update card
# parses (extractReleaseNoteSummary in apps/desktop/src/updates/releaseNotes.ts): a `v… · stats`
# line, bullets, an optional `### Plus …` footer, then a <details> Full changelog the card skips.
#
#   fork-release-notes.sh <version> [<previous release ref>]
#
# Needs the history back to the previous release, and GH_TOKEN for upstream's release body.
set -euo pipefail

version="$1"
previous="${2:-}"
upstream_repo="pingdotgg/t3code"
head="$(git rev-parse HEAD)"

range=("$head")
[[ -n "$previous" ]] && range+=("^$previous")

# Upstream releases merged since the previous release; their commits are upstream's, not Boat's.
upstream_refs=()
exclude=()
while IFS=' ' read -r merge subject; do
  # fork-sync.yml's merge subject; Fork-Sync: is not parsed as a trailer when lines follow it.
  [[ "$subject" =~ ^Merge\ upstream\ (v[^ ]+)\ into\ boat$ ]] || continue
  upstream_refs+=("${BASH_REMATCH[1]}")
  exclude+=("^$(git rev-parse "$merge^2")")
done < <(git log --merges --format='%H %s' "${range[@]}")

max=()
[[ -n "$previous" ]] || max=(--max-count=30)
boat_log="$(git log --no-merges "${max[@]}" --format='%h %s' "${range[@]}" "${exclude[@]}")"

highlights=()
while IFS=' ' read -r _ subject; do
  [[ -n "$subject" ]] || continue
  # Conventional commits: only user-facing types make the card; the changelog keeps them all.
  if [[ "$subject" =~ ^([a-z]+)(\([^\)]*\))?!?:\ (.+)$ ]]; then
    case "${BASH_REMATCH[1]}" in
      feat | fix | perf | revert) subject="${BASH_REMATCH[3]}" ;;
      *) continue ;;
    esac
  fi
  highlights+=("- ${subject^}")
done <<<"$boat_log"

upstream_highlights=""
upstream_footer=""
newest_upstream="${upstream_refs[0]:-}"
if [[ -n "$newest_upstream" ]]; then
  body="$(gh release view "$newest_upstream" --repo "$upstream_repo" --json body --jq .body 2>/dev/null || true)"
  summary="$(printf '%s\n' "$body" | sed '/<details>/,$d' | tr -d '\r')"
  upstream_highlights="$(printf '%s\n' "$summary" | grep -E '^[-*] ' || true)"
  upstream_footer="$(printf '%s\n' "$summary" | grep -m1 -E '^### Plus [0-9]+ more ' || true)"
fi

boat_count="${#highlights[@]}"
boat_label="$boat_count Boat $([[ "$boat_count" == 1 ]] && echo change || echo changes)"
if [[ -n "$newest_upstream" ]] && ((boat_count == 0)); then
  stats="T3 Code $newest_upstream"
elif [[ -n "$newest_upstream" ]]; then
  stats="T3 Code $newest_upstream + $boat_label"
elif ((boat_count > 0)); then
  stats="$boat_label"
else
  stats="No user-facing changes"
fi

{
  printf '**v%s** · %s\n\n' "$version" "$stats"
  [[ -n "$upstream_highlights" ]] && printf '%s\n' "$upstream_highlights"
  ((boat_count > 0)) && printf '%s\n' "${highlights[@]}"
  [[ -n "$upstream_footer" ]] && printf '\n%s\n' "$upstream_footer"
  printf '\n<details>\n<summary>Full changelog</summary>\n\n'
  for ref in "${upstream_refs[@]}"; do
    printf '## Upstream %s\n\nhttps://github.com/%s/releases/tag/%s\n\n' "$ref" "$upstream_repo" "$ref"
  done
  printf '## Boat\n\n'
  if [[ -n "$boat_log" ]]; then
    printf '%s\n' "$boat_log" | sed -E 's/^([0-9a-f]+) (.*)$/- \2 (\1)/'
  else
    printf 'No Boat commits.\n'
  fi
  printf '\n</details>\n\n'
  printf 'Built from %s on boat. Self-signed (not notarized) macOS arm64 build, plus t3 server archives for macOS arm64 and Linux x64/arm64. Installed fork builds update themselves from this feed; to install by hand, unzip and move the app into /Applications.\n' "${head:0:10}"
}
