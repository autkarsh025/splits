#!/usr/bin/env bash
# Publish built pages (only) to the public site repo autkarsh025.github.io.
# Usage: deploy.sh <folder-on-site> <local-build-dir> [<local-dir-copied-to-site-root>]
# Needs SITE_DEPLOY_TOKEN (fine-grained token: contents read/write on autkarsh025.github.io only).
set -euo pipefail
NAME="$1"; SRC="$2"; ROOT_EXTRA="${3:-}"
if [ -z "${SITE_DEPLOY_TOKEN:-}" ]; then echo "SITE_DEPLOY_TOKEN not set; skipping deploy"; exit 0; fi
WORK="$(mktemp -d)"
git clone -q --depth 1 "https://x-access-token:${SITE_DEPLOY_TOKEN}@github.com/autkarsh025/autkarsh025.github.io.git" "$WORK" 2>/dev/null || {
  echo "could not clone the site repo (does autkarsh025.github.io exist, and can the token write to it?)"; exit 1; }
cd "$WORK"
git checkout -q -B main
rm -rf "$NAME" && mkdir -p "$NAME" && cp -R "$GITHUB_WORKSPACE/$SRC/." "$NAME/"
[ -n "$ROOT_EXTRA" ] && cp -R "$GITHUB_WORKSPACE/$ROOT_EXTRA/." .
touch .nojekyll                      # serve files as-is (no Jekyll processing)
git config user.name "site deploy"
git config user.email "actions@users.noreply.github.com"
git add -A
if git diff --cached --quiet; then echo "site already up to date"; exit 0; fi
git commit -q -m "Update ${NAME}"
for i in 1 2 3; do
  git push -q origin main && { echo "published ${NAME}"; exit 0; }
  sleep 5; git pull -q --rebase origin main || true
done
echo "push to the site repo failed"; exit 1
