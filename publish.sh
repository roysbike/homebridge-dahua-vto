#!/usr/bin/env bash
# Publish a pre-release (rc/beta) or stable build to npm.
#
# Usage:
#   ./publish.sh beta             # publish current version with --tag beta (default)
#   ./publish.sh rc
#   ./publish.sh stable           # --tag latest (only for non-prerelease versions)
#   ./publish.sh beta --bump      # bump prerelease then publish
#   OTP=123456 ./publish.sh beta

set -euo pipefail
cd "$(dirname "$0")"

CHANNEL="${1:-beta}"
BUMP=false
shift || true
for arg in "$@"; do
  [[ "$arg" == "--bump" ]] && BUMP=true
done

VERSION="$(node -p "require('./package.json').version")"
OTP_ARGS=()
if [[ -n "${OTP:-}" ]]; then
  OTP_ARGS=(--otp="$OTP")
fi

case "$CHANNEL" in
  rc|beta)
    if [[ "$BUMP" == true ]]; then
      npm version "prerelease" --preid="$CHANNEL" --no-git-tag-version
      VERSION="$(node -p "require('./package.json').version")"
    fi
    if [[ "$VERSION" != *"-${CHANNEL}"* && "$VERSION" != *"-$CHANNEL."* ]]; then
      echo "Version is '$VERSION' — expected a -$CHANNEL prerelease (e.g. 1.0.1-$CHANNEL.1)."
      echo "Run: ./publish.sh $CHANNEL --bump   or set version in package.json"
      exit 1
    fi
    echo "Publishing $VERSION → npm tag '$CHANNEL'"
    npm publish --access public --tag "$CHANNEL" "${OTP_ARGS[@]}"
    ;;
  stable|latest)
    if [[ "$VERSION" == *-* ]]; then
      echo "Refusing to publish prerelease '$VERSION' as latest."
      echo "Set a stable version first, e.g. 1.0.1 (no -rc / -beta)."
      exit 1
    fi
    echo "Publishing $VERSION → npm tag 'latest'"
    npm publish --access public --tag latest "${OTP_ARGS[@]}"
    ;;
  *)
    echo "Usage: ./publish.sh {rc|beta|stable} [--bump]"
    exit 1
    ;;
esac

echo "Done: https://www.npmjs.com/package/homebridge-dahua-vto"
echo "Install: npm install -g homebridge-dahua-vto@$CHANNEL"
