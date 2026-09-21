# syntax=docker/dockerfile:1.7
# Spec §4.4: multi-stage — build the Mini App, then a runtime image with the server and the bundle.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS build
ENV CI=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/miniapp/package.json apps/miniapp/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm --filter @group-chess/miniapp build && node scripts/check-bundle-size.mjs

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=1 pnpm install --frozen-lockfile --prod --filter "@group-chess/server..." \
    && chown -R node:node /app
COPY --from=build --chown=node:node /app/apps/miniapp/dist ./apps/miniapp/dist
ENV MINI_APP_DIR=/app/apps/miniapp/dist
ENV PORT=3000
EXPOSE 3000
USER node
WORKDIR /app/apps/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Node runs tsx directly: no pnpm (and no corepack download) at start, and SIGTERM reaches the
# process so the shutdown in index.ts runs.
CMD ["node", "--import", "tsx", "src/index.ts"]
