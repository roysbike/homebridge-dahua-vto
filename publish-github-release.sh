#!/usr/bin/env bash
# Push main + tag v1.0.1 and create GitHub Release.
# Usage:
#   ./publish-github-release.sh
# Optional:
#   GIT_SSH_KEY=/Users/roys/.ssh/home/roys
#   GITHUB_TOKEN=ghp_...   # if gh is not installed, uses API

set -euo pipefail
cd "$(dirname "$0")"

GIT_SSH_KEY="${GIT_SSH_KEY:-/Users/roys/.ssh/home/roys}"
export GIT_SSH_COMMAND="ssh -i ${GIT_SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
REPO="roysbike/homebridge-dahua-vto"
TITLE="${TAG} — First stable release"

echo "==> Push main"
git push origin main

echo "==> Tag ${TAG}"
git tag -fa "$TAG" -m "$TAG"
git push -f origin "refs/tags/${TAG}"

echo "==> Create GitHub Release"
if command -v gh >/dev/null 2>&1; then
  gh release delete "$TAG" -y 2>/dev/null || true
  gh release create "$TAG" \
    --repo "$REPO" \
    --title "$TITLE" \
    --notes-file RELEASE_NOTES.md \
    --latest
else
  if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "gh not found. Open manually:"
    echo "  https://github.com/${REPO}/releases/new?tag=${TAG}"
    echo "Paste contents of RELEASE_NOTES.md"
    echo "Or: export GITHUB_TOKEN=ghp_xxx && ./publish-github-release.sh"
    exit 0
  fi
  BODY="$(node -e "const fs=require('fs');console.log(JSON.stringify(fs.readFileSync('RELEASE_NOTES.md','utf8')))")"
  curl -sS -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    "https://api.github.com/repos/${REPO}/releases" \
    -d "{\"tag_name\":\"${TAG}\",\"name\":\"${TITLE}\",\"body\":${BODY},\"draft\":false,\"prerelease\":false,\"make_latest\":\"true\"}"
  echo
fi

echo
echo "Done: https://github.com/${REPO}/releases/tag/${TAG}"
