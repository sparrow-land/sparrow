# sparrow — single-container image (API + web UI)
FROM node:22-slim AS build
# python3/make/g++: fallback toolchain for native deps (better-sqlite3) when
# prebuilt binaries can't be downloaded.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Bundle the CLI + MCP into single-file install artifacts served by the API.
# In-image bundling after the full source COPY keeps the served bundles on the
# exact same source snapshot as the server dist. `.git` is not in the context,
# so pass `--build-arg BUILD_SHA=$(git rev-parse --short HEAD)` for a real
# version stamp (referencing the ARG also re-keys this layer per commit);
# without it the bundles are stamped `<version>+<date>.dev` — never ship those.
ARG BUILD_SHA
RUN BUILD_SHA="$BUILD_SHA" pnpm --filter @sparrow/api bundle-clients \
    && if [ -n "$BUILD_SHA" ]; then \
         for f in sparrow.js sparrow-mcp.js; do \
           grep -q "+[0-9]\{8\}\.$BUILD_SHA\"" "apps/api/install-assets/$f" \
             || { echo "FATAL: install-assets/$f is not stamped with BUILD_SHA=$BUILD_SHA (stale or unstamped bundle)" >&2; exit 1; }; \
         done; \
       fi
# Web UI is served by the API from apps/api/public
RUN if [ -d apps/web/dist ]; then rm -rf apps/api/public && cp -r apps/web/dist apps/api/public; fi

# Production node_modules only (api + its workspace deps)
FROM node:22-slim AS proddeps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/common-types/package.json ./packages/common-types/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --prod --frozen-lockfile --filter "@sparrow/api..."

FROM node:22-slim
WORKDIR /app
COPY --from=proddeps /app ./
COPY --from=build /app/packages/common-types/dist ./packages/common-types/dist
COPY --from=build /app/packages/common-types/package.json ./packages/common-types/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/public ./apps/api/public
COPY --from=build /app/apps/api/install-assets ./apps/api/install-assets
COPY --from=build /app/apps/api/package.json ./apps/api/

ENV NODE_ENV=production \
    PORT=8722 \
    DATA_DIR=/data

# The server runs as the unprivileged `node` user (uid/gid 1000, already present
# in the base image); /app stays root-owned and read-only to it.
#
# There is deliberately NO `USER node` directive. Ownership of /data is settled
# at RUNTIME, not build time, because a Docker named volume is populated from
# the image only when it is EMPTY — an existing deployment upgrading into this
# image keeps its root-owned volume, which a build-time chown would never reach.
# So the container is ENTERED as root, the entrypoint fixes /data once, and then
# drops to `node` before exec'ing anything. `USER node` would hand that repair to
# a user who cannot perform it, and every pre-1.0 volume would come up read-only.
# The cost of the choice: `docker exec <container> …` lands as ROOT (only the
# entrypoint's own command tree is dropped) — use `docker exec --user node`, as
# the README's self-hosting notes say.
#
# `as-node` is the drop half on its own, so anything the RUNTIME starts outside
# the entrypoint (the healthcheck below) runs unprivileged too without paying for
# the /data walk. Running the container with an explicit non-root user (compose
# `user: "1000:1000"`, or `docker run --user`) skips the root phase entirely in
# both scripts; /data must then already be writable by that uid.
RUN mkdir -p /data && chown node:node /data \
    && { \
      echo '#!/bin/sh'; \
      echo '# Exec "$@" as node, dropping from root only when we started as root.'; \
      echo 'set -e'; \
      echo 'if [ "$(id -u)" = "0" ]; then'; \
      echo '  exec setpriv --reuid=node --regid=node --init-groups "$@"'; \
      echo 'fi'; \
      echo 'exec "$@"'; \
    } > /usr/local/bin/as-node \
    && { \
      echo '#!/bin/sh'; \
      echo 'set -e'; \
      echo 'if [ "$(id -u)" = "0" ]; then'; \
      echo '  # Cheap when already correct; also repairs volumes written by'; \
      echo '  # pre-non-root images (files there are owned by root).'; \
      echo '  chown node:node /data 2>/dev/null || true'; \
      echo '  find /data ! -user node -exec chown node:node {} + 2>/dev/null || true'; \
      echo 'fi'; \
      echo 'exec /usr/local/bin/as-node "$@"'; \
    } > /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/as-node /usr/local/bin/entrypoint.sh

VOLUME /data
EXPOSE 8722
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD as-node node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8722)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/api/dist/index.js"]
