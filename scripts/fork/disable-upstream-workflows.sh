#!/usr/bin/env bash
# Disables every GitHub Actions workflow of this fork except the fork-*.yml ones, so upstream's
# release / review / triage pipelines never run here. The state is a repository setting, not a
# file change, so it causes no merge conflicts when syncing upstream.
#
# Usage: scripts/fork/disable-upstream-workflows.sh [owner/repo]
set -euo pipefail

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
if [ "$REPO" = "ding113/claude-code-hub" ]; then
  echo "Refusing to change workflows of the upstream repository." >&2
  exit 1
fi

# Uses the REST API directly so it works with old gh releases (no `gh workflow list --json`).
gh api "repos/$REPO/actions/workflows?per_page=100" \
  --jq '.workflows[] | [(.id | tostring), .path, .state] | @tsv' |
  while IFS=$'\t' read -r id path state; do
    name="$(basename "$path")"
    case "$name" in
      fork-*)
        if [ "$state" != "active" ]; then
          gh api -X PUT "repos/$REPO/actions/workflows/$id/enable" || true
        fi
        echo "keep     $path"
        ;;
      *)
        if [ "$state" = "active" ]; then
          gh api -X PUT "repos/$REPO/actions/workflows/$id/disable" || true
          echo "disabled $path"
        else
          echo "skipped  $path ($state)"
        fi
        ;;
    esac
  done
