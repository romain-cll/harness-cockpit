#!/usr/bin/env bash
# Decides what the CI runs and writes `flag`, `desktop` and `packages` to $GITHUB_OUTPUT.
# A push, or a pull request touching a file every package depends on (turbo's
# --affected does not see them all), runs everything: `flag` is empty. Otherwise
# `flag` is --affected and the two booleans say which side turbo selects.
set -euo pipefail

# On a pull request's merge commit, the first parent is the base branch.
export TURBO_SCM_BASE=HEAD^1
export TURBO_SCM_HEAD=HEAD

global='^(bun\.lock|package\.json|turbo\.json|tsconfig\.base\.json|\.oxlintrc\.json|\.github/workflows/ci\.yml|\.github/actions/.*|\.github/scripts/ci-scope\.sh)$'

if [ "${GITHUB_EVENT_NAME:-}" = "push" ] || git diff --name-only HEAD^1 HEAD | grep -Eq "$global"; then
  flag=''
  desktop=true
  packages=true
else
  flag=--affected
  # plane-sync is no package: its tests run on every pull request (repo-checks).
  names=$(bun turbo ls --affected --output=json | jq -r '.packages.items[].name')
  desktop=false
  packages=false
  if grep -qx '@cockpit/desktop' <<<"$names"; then desktop=true; fi
  if [ -n "$names" ] && grep -vqxE '@cockpit/desktop|@cockpit/plane-sync' <<<"$names"; then packages=true; fi
fi

{
  echo "flag=$flag"
  echo "desktop=$desktop"
  echo "packages=$packages"
} >>"$GITHUB_OUTPUT"
