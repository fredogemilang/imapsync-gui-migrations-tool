FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# ---- dev ----
FROM base AS dev
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --filter @emt/api...
COPY apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["pnpm", "run", "dev"]

# ---- build ----
FROM base AS build
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --filter @emt/api...
COPY apps/api ./apps/api
WORKDIR /app/apps/api
RUN pnpm run build

# ---- prod ----
FROM node:20-bookworm-slim AS prod
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --filter @emt/api... --prod
COPY --from=build /app/apps/api/dist ./apps/api/dist
# drizzle-kit needs both the config + the schema source file at runtime
# so the entrypoint can call `drizzle-kit push --force` to auto-apply
# any pending schema changes when the container starts.
COPY apps/api/drizzle.config.ts apps/api/
COPY apps/api/src/db ./apps/api/src/db
COPY apps/api/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
WORKDIR /app/apps/api
EXPOSE 3000
ENTRYPOINT ["/docker-entrypoint.sh"]
