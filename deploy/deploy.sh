#!/usr/bin/env bash
# Deploy sparrow to a docker host over SSH.
#
#   deploy/deploy.sh stg          # sparrow-dev.site  -> m3, container sparrow-stg
#   deploy/deploy.sh prd          # sparrow-hq.com -> m3, container sparrow-prd
#
# Requires: doppler (authed to project sparrow), ssh access to $DEPLOY_HOST.
# The container binds to 127.0.0.1:<port> on the host; put your reverse proxy
# (caddy/nginx/traefik) in front for TLS. A Caddyfile snippet is printed after deploy.
set -euo pipefail

ENV="${1:?usage: deploy.sh <stg|prd>}"
DEPLOY_HOST="${DEPLOY_HOST:-m3}"
IMAGE="${IMAGE:-ghcr.io/sparrow-land/sparrow:latest}"
# IMAGE_SOURCE=registry pulls $IMAGE on the host (needs the GHCR package to be
# public or a docker login there). IMAGE_SOURCE=local (default) builds the image
# here and streams it over SSH — no registry access needed.
IMAGE_SOURCE="${IMAGE_SOURCE:-local}"

case "$ENV" in
  stg) NAME=sparrow-stg; HOST_PORT=8801; DOMAIN=sparrow-dev.site ;;
  prd) NAME=sparrow-prd; HOST_PORT=8802; DOMAIN=sparrow-hq.com ;;
  *) echo "env must be stg or prd" >&2; exit 1 ;;
esac

echo "==> Fetching secrets from Doppler (sparrow/$ENV)"
ADMIN_TOKEN=$(doppler secrets get ADMIN_TOKEN -p sparrow -c "$ENV" --plain)
BASE_URL=$(doppler secrets get BASE_URL -p sparrow -c "$ENV" --plain)

if [ "$IMAGE_SOURCE" = "local" ]; then
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  echo "==> Building $IMAGE locally and streaming it to $DEPLOY_HOST"
  docker build -t "$IMAGE" "$REPO_ROOT"
  docker save "$IMAGE" | gzip | ssh "$DEPLOY_HOST" 'gunzip | docker load'
fi

echo "==> Deploying $IMAGE as $NAME on $DEPLOY_HOST (port $HOST_PORT, $BASE_URL)"
ssh "$DEPLOY_HOST" bash -s -- <<EOF
set -euo pipefail
[ "$IMAGE_SOURCE" = "registry" ] && docker pull "$IMAGE"
docker rm -f "$NAME" 2>/dev/null || true
docker run -d --name "$NAME" --restart unless-stopped \
  -p 127.0.0.1:$HOST_PORT:8722 \
  -v ${NAME}-data:/data \
  -e BASE_URL="$BASE_URL" \
  -e ADMIN_TOKEN="$ADMIN_TOKEN" \
  "$IMAGE"
sleep 2
curl -fsS "http://127.0.0.1:$HOST_PORT/healthz" && echo && echo "healthz OK"
EOF

cat <<EOF

==> Done. Reverse-proxy snippet (Caddyfile) for $DOMAIN:

$DOMAIN {
    reverse_proxy 127.0.0.1:$HOST_PORT
}

EOF
