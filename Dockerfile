FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.16.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/pick-engine/package.json packages/pick-engine/package.json
RUN pnpm install --frozen-lockfile
COPY apps/server/src ./apps/server/src
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY apps/web/index.html apps/web/tsconfig.json apps/web/vite.config.ts ./apps/web/
COPY apps/web/public ./apps/web/public
COPY apps/web/src ./apps/web/src
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/pick-engine/src ./packages/pick-engine/src
COPY packages/pick-engine/tsconfig.json ./packages/pick-engine/tsconfig.json
COPY migrations ./migrations
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production DATABASE_PATH=/data/picknext.db PORT=5560
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/pick-engine/package.json ./packages/pick-engine/package.json
COPY --from=build /app/packages/pick-engine/node_modules ./packages/pick-engine/node_modules
COPY --from=build /app/packages/pick-engine/dist ./packages/pick-engine/dist
COPY --from=build /app/migrations ./migrations
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 5560
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:5560/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/server/dist/main.js"]
