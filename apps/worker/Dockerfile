FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# imapsync + Perl deps (imapsync is not in Debian main; install script from GitHub)
RUN apt-get update && apt-get install -y --no-install-recommends \
      perl \
      libauthen-ntlm-perl \
      libcgi-pm-perl \
      libcrypt-openssl-rsa-perl \
      libdata-uniqid-perl \
      libencode-imaputf7-perl \
      libfile-copy-recursive-perl \
      libfile-tail-perl \
      libio-socket-inet6-perl \
      libio-socket-ssl-perl \
      libio-tee-perl \
      libhtml-parser-perl \
      libjson-webtoken-perl \
      libmail-imapclient-perl \
      libparse-recdescent-perl \
      libproc-processtable-perl \
      libmodule-scandeps-perl \
      libreadonly-perl \
      libregexp-common-perl \
      libsys-meminfo-perl \
      libterm-readkey-perl \
      libtest-mockobject-perl \
      libunicode-string-perl \
      liburi-perl \
      libwww-perl \
      libtest-nowarnings-perl \
      libtest-deep-perl \
      libtest-warn-perl \
      make \
      time \
      cpanminus \
      curl \
      procps \
      ca-certificates \
    && curl -fsSL -o /usr/local/bin/imapsync \
         https://raw.githubusercontent.com/imapsync/imapsync/master/imapsync \
    && chmod +x /usr/local/bin/imapsync \
    && imapsync --version || true \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- dev ----
FROM base AS dev
COPY package.json pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/
RUN pnpm install --filter @emt/worker...
COPY apps/worker ./apps/worker
WORKDIR /app/apps/worker
CMD ["pnpm", "run", "dev"]

# ---- build ----
FROM base AS build
COPY package.json pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/
RUN pnpm install --filter @emt/worker...
COPY apps/worker ./apps/worker
WORKDIR /app/apps/worker
RUN pnpm run build

# ---- prod ----
FROM base AS prod
ENV NODE_ENV=production
COPY package.json pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/
RUN pnpm install --filter @emt/worker... --prod
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
