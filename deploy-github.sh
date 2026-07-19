#!/usr/bin/env bash
# Deploy homebridge-dahua-vto to GitHub (create repo + push).
#
# Usage:
#   export GITHUB_USER=your-github-username
#   ./deploy-github.sh
#
# Optional:
#   export GITHUB_REPO=homebridge-dahua-vto   # default
#   export GIT_SSH_KEY=/Users/roys/.ssh/home/roys

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

GITHUB_USER="${GITHUB_USER:-}"
GITHUB_REPO="${GITHUB_REPO:-homebridge-dahua-vto}"
GIT_SSH_KEY="${GIT_SSH_KEY:-/Users/roys/.ssh/home/roys}"

if [[ -z "$GITHUB_USER" ]]; then
  echo "Set GITHUB_USER first, e.g.:"
  echo "  export GITHUB_USER=your-github-username"
  echo "  ./deploy-github.sh"
  exit 1
fi

if [[ ! -f "$GIT_SSH_KEY" ]]; then
  echo "SSH key not found: $GIT_SSH_KEY"
  exit 1
fi

export GIT_SSH_COMMAND="ssh -i ${GIT_SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

REMOTE="git@github.com:${GITHUB_USER}/${GITHUB_REPO}.git"
AUTHOR_NAME="$(git config --global user.name 2>/dev/null || echo "Artem Goncharenko")"
AUTHOR_EMAIL="$(git config --global user.email 2>/dev/null || echo "")"

echo "==> Patching package.json / README for github.com/${GITHUB_USER}/${GITHUB_REPO}"
# macOS sed
sed -i '' "s|YOUR_GITHUB|${GITHUB_USER}|g" package.json README.md 2>/dev/null || \
  sed -i "s|YOUR_GITHUB|${GITHUB_USER}|g" package.json README.md

# author + repo URLs in package.json
AUTHOR_NAME="$AUTHOR_NAME" GITHUB_USER="$GITHUB_USER" GITHUB_REPO="$GITHUB_REPO" node <<'NODE'
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
const user = process.env.GITHUB_USER;
const repo = process.env.GITHUB_REPO;
if (!p.author) p.author = process.env.AUTHOR_NAME || "Artem Goncharenko";
p.repository = p.repository || {};
p.repository.type = "git";
p.repository.url = `git+https://github.com/${user}/${repo}.git`;
p.bugs = { url: `https://github.com/${user}/${repo}/issues` };
p.homepage = `https://github.com/${user}/${repo}#readme`;
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
NODE

if [[ ! -f .gitignore ]]; then
  cat > .gitignore <<'EOF'
node_modules/
package-lock.json
*.tgz
.DS_Store
*.log
.idea/
.vscode/
EOF
fi

if [[ ! -d .git ]]; then
  echo "==> git init"
  git init -b main
fi

git add -A
if git diff --cached --quiet; then
  echo "==> Nothing to commit"
else
  git -c user.name="$AUTHOR_NAME" ${AUTHOR_EMAIL:+-c user.email="$AUTHOR_EMAIL"} \
    commit -m "$(cat <<'EOF'
Initial homebridge-dahua-vto plugin.

Camera, lock, doorbell, two-way Amcrest audio.cgi, optional HKSV.
EOF
)"
fi

echo "==> Ensure GitHub repo exists: ${GITHUB_USER}/${GITHUB_REPO}"
if command -v gh >/dev/null 2>&1; then
  gh repo view "${GITHUB_USER}/${GITHUB_REPO}" >/dev/null 2>&1 || \
    gh repo create "${GITHUB_USER}/${GITHUB_REPO}" --public --source=. --remote=origin --push
else
  # Create via API if GITHUB_TOKEN set; otherwise assume repo already created on github.com
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl -sS -X POST \
      -H "Authorization: token ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      https://api.github.com/user/repos \
      -d "{\"name\":\"${GITHUB_REPO}\",\"private\":false}" \
      >/dev/null || true
  else
    echo "    Tip: create empty repo https://github.com/new name=${GITHUB_REPO} (public), then re-run if push fails."
  fi
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

echo "==> Push to ${REMOTE}"
git push -u origin HEAD:main

echo
echo "Done: https://github.com/${GITHUB_USER}/${GITHUB_REPO}"
echo
echo "Publish to npm (optional):"
echo "  npm login"
echo "  npm publish --access public"
