#!/bin/sh
# API container entrypoint.
#
# Runs `drizzle-kit push --force` to apply any pending schema changes
# before the server starts listening. This makes Dokploy deploys
# fully automated — no manual `docker compose exec api pnpm db:push`
# required after a deploy that touched apps/api/src/db/schema.ts.
#
# WARNING: --force accepts schema diffs that may cause data loss
# (dropped columns, narrowed types). For this self-hosted single-admin
# tool we accept that trade-off because we snapshot the Postgres volume
# regularly per DEPLOY.md backup checklist. If you want strict review
# before destructive changes, replace this script's body with:
#   pnpm drizzle-kit generate           # in CI, commit migrations
#   node dist/run-migrate.js            # at boot, apply only generated SQL
set -e

echo "[entrypoint] applying schema (drizzle-kit push)…"
pnpm drizzle-kit push --force
echo "[entrypoint] schema up-to-date. starting server."

exec node dist/server.js
