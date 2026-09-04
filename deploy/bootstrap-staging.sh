#!/usr/bin/env bash
# Bootstrap sparrow inside a fresh Debian LXC.
# Fetched and piped to bash via the Proxmox console.
#   args: PAT ADMIN_TOKEN BASE_URL [CONTAINER_NAME] [RELEASE_TAG]
# Defaults target staging; pass CONTAINER_NAME/RELEASE_TAG so prod can reuse it.
# Idempotent: safe to re-run for redeploys (docker install is skipped if present).
set -euo pipefail
PAT="$1"; ADMIN_TOKEN="$2"; BASE_URL="$3"
CONTAINER_NAME="${4:-sparrow-stg}"
RELEASE_TAG="${5:-staging-image}"
REPO="sparrow-land/sparrow"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gzip >/dev/null
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh

echo "==> Fetching image asset from release $RELEASE_TAG"
ASSET=$(curl -fsS -H "Authorization: token $PAT" \
  "https://api.github.com/repos/$REPO/releases/tags/$RELEASE_TAG" \
  | grep -o '"url": *"https://api.github.com/repos/[^"]*/releases/assets/[0-9]*"' \
  | head -1 | grep -o 'https://[^"]*')
[ -n "$ASSET" ] || { echo "no asset found on release $RELEASE_TAG" >&2; exit 1; }
curl -fsSL -H "Authorization: token $PAT" -H "Accept: application/octet-stream" \
  "$ASSET" -o /tmp/sparrow-image.tar.gz

echo "==> Loading image"
gunzip -f /tmp/sparrow-image.tar.gz
docker load -i /tmp/sparrow-image.tar
rm -f /tmp/sparrow-image.tar

echo "==> Starting container $CONTAINER_NAME"
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
  -p 8722:8722 \
  -v "${CONTAINER_NAME}-data":/data \
  -e BASE_URL="$BASE_URL" \
  -e ADMIN_TOKEN="$ADMIN_TOKEN" \
  sparrow:staging

sleep 3
curl -fsS http://127.0.0.1:8722/healthz
echo
echo "BOOTSTRAP-COMPLETE"
