# sparrow-mail-gateway — the OSS mail edge, as a sidecar image.
#
# Build from the REPO ROOT (it needs the pnpm workspace, `packages/mail-parse`
# and `packages/common-types`):
#
#     docker build -f apps/mail-gateway/Dockerfile -t sparrow-mail-gateway .
#
# Everything is configured by env — see `src/config.ts` and SPEC.md
# (`apps/mail-gateway`). The container is stateless: no volume, no database.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# Filtered install: the gateway and its workspace deps only, so this image never
# builds the API's native better-sqlite3 toolchain.
RUN pnpm install --frozen-lockfile --filter "@sparrow/mail-gateway..."
RUN pnpm --filter "@sparrow/mail-gateway..." build

# Production node_modules only (gateway + its workspace deps).
FROM node:22-slim AS proddeps
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/common-types/package.json ./packages/common-types/
COPY packages/mail-parse/package.json ./packages/mail-parse/
COPY apps/mail-gateway/package.json ./apps/mail-gateway/
RUN pnpm install --prod --frozen-lockfile --filter "@sparrow/mail-gateway..."

FROM node:22-slim
WORKDIR /app
COPY --from=proddeps /app ./
COPY --from=build /app/packages/common-types/dist ./packages/common-types/dist
COPY --from=build /app/packages/common-types/package.json ./packages/common-types/
COPY --from=build /app/packages/mail-parse/dist ./packages/mail-parse/dist
COPY --from=build /app/packages/mail-parse/package.json ./packages/mail-parse/
COPY --from=build /app/apps/mail-gateway/dist ./apps/mail-gateway/dist
COPY --from=build /app/apps/mail-gateway/package.json ./apps/mail-gateway/

ENV NODE_ENV=production \
    MAIL_SMTP_PORT=2525 \
    MAIL_OUTBOUND_PORT=2526
EXPOSE 2525 2526
# The outbound listener doubles as the readiness endpoint (`/healthz`).
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAIL_OUTBOUND_PORT||2526)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/mail-gateway/dist/index.js"]
