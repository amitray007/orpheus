#!/usr/bin/env bash
# Generate release notes for a new tag.
#
# Usage: release-changelog.sh <new-tag>
#
# Walks git log from the previous v-tag up to HEAD^ (skipping the chore(release)
# bump commit that this script is invoked against). Filters out internal
# commits — release-bump commits and bulk prettier formatting passes — so the
# notes read as a list of user-facing changes.

set -euo pipefail

NEW_TAG="${1:-}"
if [ -z "$NEW_TAG" ]; then
  echo "usage: $0 <new-tag>" >&2
  exit 1
fi

REPO_URL="https://github.com/amitray007/orpheus"

# Previous tag — strip the new tag itself from consideration in case it was
# already created locally before this script runs.
PREV_TAG=$(git tag --sort=-version:refname | grep -v "^${NEW_TAG}$" | head -n1 || true)

# Filter regex: skip release-bump commits and prettier-only formatting commits.
SKIP='^- (chore\(release\)|style: prettier|chore: prettier)'

if [ -n "$PREV_TAG" ]; then
  LOG=$(git log "${PREV_TAG}..HEAD^" --pretty=format:'- %s (%h)' --reverse | grep -vE "$SKIP" || true)
  COMPARE_LINE="**Full Changelog**: ${REPO_URL}/compare/${PREV_TAG}...${NEW_TAG}"
  HEADING="## What's Changed"
else
  # First release — repo has no previous tag. Show only the last 20 substantive
  # commits to avoid a wall of history.
  LOG=$(git log "HEAD^" --pretty=format:'- %s (%h)' | grep -vE "$SKIP" | head -n 20 || true)
  COMPARE_LINE=""
  HEADING="## Initial Release"
fi

if [ -z "$LOG" ]; then
  LOG="_(no notable commits since the previous release)_"
fi

cat <<MD
${HEADING}

${LOG}

${COMPARE_LINE}

## Install

\`\`\`sh
export HOMEBREW_GITHUB_API_TOKEN="\$(gh auth token)"
brew tap amitray007/tap
brew install --cask orpheus
\`\`\`

## Upgrade

\`\`\`sh
brew upgrade --cask orpheus
\`\`\`
MD
