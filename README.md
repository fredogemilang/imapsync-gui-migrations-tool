# Email Migration Tools

Self-hosted IMAP email migration dashboard with single & bulk migration, real-time progress, auto-sync schedules, and Dokploy-ready deployment.

## Stack

- **Frontend**: Vite + React + TypeScript + Tailwind v4 (light/dark mode)
- **Backend**: Node.js + Fastify + Drizzle ORM (Postgres) + BullMQ (Redis)
- **IMAP**: Hybrid — `imapflow` (test / scan / inspect) + `imapsync` binary (migration + delta sync)
- **Realtime**: Server-Sent Events (refcounted shared subscriber)
- **Deploy**: Docker Compose, Traefik labels for Dokploy

## Features

- **Single migration wizard** — Step 1 credential check → Step 2 review (with target QUOTA + existing-content inspection) → Step 3 live progress with envelope animation, per-folder breakdown, time-remaining ETA
- **Bulk migration** — Step 1 form with per-pair table OR CSV upload (parsed 100% client-side), Step 2 per-pair scan + settings, Step 3 active-mailbox synchronizations table
- **Post-migration sync** — Auto Sync (3h cadence, 10-day cap) / Backup Mode (daily/weekly/monthly, no expiry) / one-off Sync Now. Wires through both single migration and per-pair for bulk.
- **In-app notifications** — completion / failure / sync errors / retention sweep summaries. Click → mark read + navigate.
- **Retention auto-cleanup** — daily sweep deletes finished migrations + bulks older than `retentionDays` (configurable; 0 = never).
- **Email header policy** — `default` / `Strip Custom Headers` (regex `X-*` removal) / `Keep All Headers`, applied via imapsync `--regexhead`.
- **Per-folder stats** — copied / skipped (dedup) / failed counts + migrated bytes, derived from imapsync stdout — works even when source IMAP doesn't advertise `STATUS=SIZE`.
- **Dark mode** — Light / Dark / System theme picker, persisted in localStorage.

## Local development (Windows + Docker Desktop)

```sh
cp .env.example .env
docker compose up --build
```

- Web: http://localhost:5173
- API: http://localhost:3000

Default admin login: `admin@example.com` / `changeme` (override via `.env`).

After first start, push schema once:

```sh
docker compose exec api pnpm run db:push
```

## Production deploy

See [DEPLOY.md](./DEPLOY.md) for Dokploy + Docker Compose deployment, schema migration, backup checklist, and scaling notes.

## Architecture

```
[ Browser ]
    │
    ├─ HTTP /api/*   ──>  api  (Fastify)
    │                       │
    │                       ├─ Postgres
    │                       │     - migrations, migration_folder (per-folder stats)
    │                       │     - bulk_migration, bulk_pair (per-pair sync flags)
    │                       │     - imap_account (encrypted credentials)
    │                       │     - notification (in-app bell inbox)
    │                       │     - app_setting (retentionDays, emailHeaderSettings, ...)
    │                       │
    │                       └─ Redis (BullMQ queues + pub/sub for SSE)
    │                             - migration         (single migration jobs)
    │                             - bulk-migration    (bulk parent jobs)
    │                             - sync              (single migration delta sync)
    │                             - bulk-pair-sync    (per-pair delta sync)
    │                             - retention         (daily cleanup sweep)
    │
    ├─ SSE  /api/migrations/:id/events    (single migration progress)
    └─ SSE  /api/bulk-migrations/:id/events (bulk + per-pair progress)
                            ▲
                            └── worker  ──> imapflow (test / scan / inspect)
                                       └─ imapsync   (migration + delta sync)
```

## Security

- Admin password hashed with `argon2id`.
- IMAP credentials encrypted at rest with **AES-256-GCM** (`MASTER_KEY` env, 32 bytes hex).
- Plaintext passwords for imapsync passed via `--passfile1/2` (not argv) and unlinked after run; boot-time sweep cleans orphan tempfiles.
- Wizard plaintext passwords held in sessionStorage with **10-minute idle expiry**.
- JWT in httpOnly cookie; CSRF protected via same-origin cookie + SameSite.
- Rate limiting on auth + IMAP test endpoints.

**Backup `MASTER_KEY`** — losing it makes stored IMAP credentials unrecoverable.
