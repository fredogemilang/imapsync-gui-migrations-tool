FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# ---- dev ----
FROM base AS dev
COPY package.json pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --filter @emt/web...
COPY apps/web ./apps/web
WORKDIR /app/apps/web
EXPOSE 5173
CMD ["pnpm", "run", "dev"]

# ---- build ----
FROM base AS build
ARG VITE_API_BASE
ENV VITE_API_BASE=$VITE_API_BASE
COPY package.json pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --filter @emt/web...
COPY apps/web ./apps/web
WORKDIR /app/apps/web
RUN pnpm run build

# ---- prod ----
FROM nginx:1.27-alpine AS prod
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
