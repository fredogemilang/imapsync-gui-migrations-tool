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

## Push schema (first time)

```sh
docker compose exec api pnpm run db:push
```

## Production deploy via Dokploy

1. **Push to GitHub.**

2. **In Dokploy**, create a new **Application** of type **Docker Compose**:
   - Repository: your GitHub repo URL
   - Branch: `main`
   - Compose file path: `docker-compose.prod.yml`

3. **Environment variables** — set these in the Dokploy app:

   ```
   POSTGRES_USER=emt
   POSTGRES_PASSWORD=<strong random>
   POSTGRES_DB=emt
   JWT_SECRET=<64 hex chars>
   MASTER_KEY=<64 hex chars>
   ADMIN_EMAIL=admin@example.com           # or admin@yourdomain.com
   ADMIN_INITIAL_PASSWORD=<temporary, change on first login via /change-password>
   PUBLIC_DOMAIN=mailmigrate.yourdomain.com
   ```

4. **Traefik / domain**:
   - In Dokploy, point the app's domain to `PUBLIC_DOMAIN`.
   - Compose labels already configure Traefik with `letsencrypt` cert resolver. If your Dokploy Traefik uses a different name, edit the labels in `docker-compose.prod.yml`.

5. **First deploy**:
   - Dokploy will build and run all services.
   - The API auto-seeds the admin user on first boot (no manual db:push needed if you rely on `drizzle-kit push`).
   - For schema management, run once: `docker compose -f docker-compose.prod.yml exec api pnpm run db:push`.

6. **Subsequent deploys**:
   - `git push` to `main` triggers Dokploy auto-deploy.

## Backup checklist

- **Postgres volume** (`pgdata`): contains all migration records and encrypted credentials. Snapshot weekly.
- **MASTER_KEY**: store in a password manager. Losing it makes encrypted credentials unrecoverable.
- **imapsync-state volume**: holds resume state files (`.bytes_*`, `.txt` per migration). Useful for resumes but rebuildable.

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
