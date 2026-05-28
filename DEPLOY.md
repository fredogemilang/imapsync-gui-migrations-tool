# Deployment Guide

## Local Development (Windows + Docker Desktop)

```sh
cp .env.example .env

# Generate a secure MASTER_KEY (32 bytes hex)
# In PowerShell:
#   -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
# Or in Linux/Mac:
#   openssl rand -hex 32

# Generate JWT_SECRET (64 hex)
# Same command as above

# Edit .env, paste your MASTER_KEY and JWT_SECRET

docker compose up --build
```

Visit http://localhost:5173, login with `admin@example.com` / `changeme` (from `.env`).

> **Tip**: For Windows, mounted node_modules can be slow. The compose file uses anonymous volumes for `node_modules` to keep them inside the container.

## Push schema

### Production (Dokploy / `docker-compose.prod.yml`) — AUTOMATIC

The API container's entrypoint runs `drizzle-kit push --force` before the
server listens. Every Dokploy deploy applies any pending schema diffs
automatically. The compose file's healthcheck + worker `depends_on api`
ensure the worker only starts after schema is up-to-date.

> **Heads up**: `--force` accepts schema changes that may cause data loss
> (dropped columns, narrowed types). For this self-hosted single-admin
> tool we accept that trade-off because the Postgres volume is snapshotted
> per the backup checklist below. If you want stricter review, replace
> the entrypoint with generated SQL migrations (see
> `apps/api/docker-entrypoint.sh` for the snippet).

### Local development — manual (avoids destructive auto-push during dev)

```sh
docker compose exec api pnpm run db:push
```

Re-run whenever you pull changes that add columns / tables. Recent additions:

- `notification` table (in-app bell)
- `migration.migrated_bytes`
- `migration_folder.migrated_bytes`, `skipped_emails`, `failed_emails`
- `bulk_pair.sync_enabled`, `backup_enabled`
- `app_setting.emailHeaderSettings` (stored as a JSON kv row, not a column)

If schema is out of sync the worker / API will throw `column "..." does not exist` on the next query.

## Production deploy via Dokploy

1. **Push to GitHub.**

2. **In Dokploy**, create a new **Application** of type **Docker Compose**:
   - Repository: your GitHub repo URL
   - Branch: `main`
   - Compose file path: `docker-compose.prod.yml`

3. **Environment variables** — set these in the Dokploy app:

   **Required**:

   ```
   POSTGRES_USER=emt
   POSTGRES_PASSWORD=<strong random>
   POSTGRES_DB=emt
   JWT_SECRET=<64 hex chars>                 # openssl rand -hex 32
   MASTER_KEY=<64 hex chars>                 # openssl rand -hex 32 — BACK THIS UP
   ADMIN_EMAIL=admin@yourdomain.com
   ADMIN_INITIAL_PASSWORD=<temp, change on first login>
   NODE_ENV=production
   ```

   **Optional** (skip unless your setup needs them):

   ```
   # Set ONLY if web is hosted on a different domain than api (split-domain).
   # Default same-origin via Dokploy domain routing works for 99% of deploys.
   # VITE_API_BASE=https://api.yourdomain.com   # build arg
   # WEB_ORIGIN=https://app.yourdomain.com      # API CORS allow
   ```

   **Do NOT set** — auto-injected by compose, would only confuse:
   - `POSTGRES_HOST` / `REDIS_HOST` (compose sets these to `postgres` / `redis`)
   - `API_PORT` (default 3000, fixed by Dockerfile EXPOSE)

4. **Configure domains in Dokploy** — open the app's **Domains** tab and add
   TWO entries pointing to the SAME hostname but DIFFERENT services + ports.
   Traefik routes incoming requests to the right container based on the
   path prefix:

   | Field          | Web (frontend)    | API (backend)              |
   | -------------- | ----------------- | -------------------------- |
   | Service Name   | `web`             | `api`                      |
   | Host           | `your-domain.com` | `your-domain.com` _(same)_ |
   | Path           | `/`               | `/api`                     |
   | Container Port | `80` _(nginx)_    | `3000` _(Fastify)_         |
   | Strip Path     | OFF               | OFF                        |
   | HTTPS          | ON                | ON                         |
   | Cert Resolver  | letsencrypt       | letsencrypt                |

   > **Important**: Leave **Strip Path OFF** for the api entry — the api
   > server expects requests at `/api/<route>`, so stripping `/api`
   > would break every endpoint.

   Result:
   - `https://your-domain.com/migrations` → web (React SPA via nginx)
   - `https://your-domain.com/api/migrations` → api (Fastify)
   - `https://your-domain.com/api/health` → api healthcheck

   No Traefik labels in the compose file — Dokploy injects them based on
   the entries above.

5. **First deploy**:
   - Dokploy builds + runs all services.
   - API container entrypoint runs `drizzle-kit push --force` to create
     the schema, then `seedAdmin()` creates the admin user from
     `ADMIN_EMAIL` + `ADMIN_INITIAL_PASSWORD`.
   - Worker waits for API healthcheck before starting, so it never
     touches a table that doesn't exist yet.

6. **Subsequent deploys**:
   - `git push` to `main` triggers Dokploy auto-deploy.
   - Schema changes are applied automatically — no manual `db:push` needed.

## Worker queues & background jobs

The worker registers five BullMQ workers + one repeatable scheduler. You'll see these in the worker logs on boot:

| Queue            | Purpose                                                          | Concurrency          |
| ---------------- | ---------------------------------------------------------------- | -------------------- |
| `migration`      | Single migration initial run (scan + imapsync)                   | `WORKER_CONCURRENCY` |
| `bulk-migration` | Bulk parent job (fans out per pair)                              | 1 (internal fan-out) |
| `sync`           | Single migration delta sync (Auto Sync / Backup Mode / Sync Now) | `WORKER_CONCURRENCY` |
| `bulk-pair-sync` | Per-pair delta sync for bulk migrations                          | `WORKER_CONCURRENCY` |
| `retention`      | Daily cleanup sweep                                              | 1                    |

Boot also resets stale `migration.syncRunning=true` flags (which can be left by a SIGKILL mid-sync) and sweeps orphan password tempfiles from previous crashes.

## Operator settings

Configurable from the in-app `/settings` page (persisted to `app_setting`):

- **Show Passwords As** — Obstructed / Readable (UI hint for inputs)
- **Number of Simultaneous Migrations** — soft cap suggestion (worker concurrency comes from `WORKER_CONCURRENCY` env)
- **Delete Finished Migrations After** — `retentionDays`. `0` = "Never Delete". The retention worker runs daily and cascade-deletes terminal-state migrations + bulks + their pairs/folders/logs/notifications.
- **Email Header Settings** — `default` / `Strip Custom Headers` / `Keep All Headers`. "Strip" passes `--regexhead 's/^X-[A-Za-z0-9-]+:[^\r\n]*\r?\n//mg'` to imapsync so vendor X-headers are removed from copied messages.

## Backup checklist

- **Postgres volume** (`pgdata`): contains all migration records, encrypted credentials, notifications, settings. Snapshot weekly.
- **MASTER_KEY**: store in a password manager. Losing it makes encrypted credentials unrecoverable.
- **imapsync-state volume**: holds resume state files (`.bytes_*`, `.txt` per migration). Useful for resumes but rebuildable.
- **Redis**: BullMQ queues. If lost, in-flight jobs and repeatable schedules are gone — repeatable sync schedules will need to be re-armed by toggling Auto Sync / Backup Mode off and on in the UI. Migration state in Postgres is unaffected.

## Scaling for medium load (50–500 mailbox, 100 GB)

In `docker-compose.prod.yml`, adjust:

```yaml
worker:
  deploy:
    replicas: 4 # bump for more concurrent migrations
```

And set per-worker concurrency via env:

```
WORKER_CONCURRENCY=3
```

Total concurrent migrations ≈ `replicas * WORKER_CONCURRENCY`. Watch postgres connection pool: increase `max` in `apps/api/src/db/index.ts` if you raise concurrency above ~10.

For bulk migrations, the bulk parent job spawns per-pair imapsync workers up to `WORKER_CONCURRENCY` inside one bulk-migration job. So with `replicas=4, WORKER_CONCURRENCY=3`, you can have 4 bulks running × 3 concurrent pairs each = 12 simultaneous imapsync processes.

## Troubleshooting

| Symptom                                                               | Likely cause                                                                        | Fix                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `column "..." does not exist`                                         | Schema out of sync                                                                  | `docker compose exec api pnpm run db:push`                                                                |
| `Route DELETE:/api/... not found`                                     | API container hasn't picked up new code (Windows + Docker Desktop file-watch quirk) | `docker compose restart api`                                                                              |
| `Body cannot be empty when content-type is set to 'application/json'` | Old API client cached in browser                                                    | Hard reload (Ctrl+Shift+R)                                                                                |
| Bell shows old notifications after delete                             | Cascade FK should clean them; verify `DELETE` returned 200                          | Manual: `DELETE FROM notification WHERE migration_id IS NULL AND bulk_id IS NULL AND read_at IS NOT NULL` |
| Auto Sync stuck — POST /sync/now returns 409                          | `migration.syncRunning=true` from a SIGKILLed prior tick                            | `docker compose restart worker` (boot sweep auto-resets)                                                  |
| Bulk migration progress page silent                                   | SSE connection may have stalled — usually only happens with reverse-proxy buffering | Ensure Traefik / nginx has `X-Accel-Buffering: no` honored (already set by API response headers)          |
