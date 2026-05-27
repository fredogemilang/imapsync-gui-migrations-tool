# Email Migration Tools

Self-hosted IMAP email migration dashboard with single & bulk migration, real-time progress, and Dokploy-ready deployment.

## Stack

- **Frontend**: Vite + React + TypeScript + Tailwind v4 + shadcn/ui
- **Backend**: Node.js + Fastify + Drizzle ORM (Postgres) + BullMQ (Redis)
- **IMAP**: Hybrid — `imapflow` (test/scan) + `imapsync` binary (migration execution)
- **Realtime**: Server-Sent Events
- **Deploy**: Docker Compose, Traefik labels for Dokploy

## Local development (Windows + Docker Desktop)

```sh
cp .env.example .env
docker compose up --build
```

- Web: http://localhost:5173
- API: http://localhost:3000

Default admin login: `admin@example.com` / `changeme` (change via `.env`).

## Production deploy (Dokploy)

1. Push to GitHub.
2. In Dokploy, create a Compose application pointing at this repo.
3. Set compose path to `docker-compose.prod.yml`.
4. Configure env vars (see `.env.example`).
5. Set `PUBLIC_DOMAIN` to your domain.
6. Deploy.

## Architecture

```
[ Browser ]
    │
    ├─ HTTP /api/*   ──>  api  (Fastify)
    │                       │
    │                       ├─ Postgres (migrations, accounts, settings)
    │                       └─ Redis  (BullMQ queues, SSE pub/sub)
    │
    └─ SSE /api/migrations/:id/events  <──  api  <── Redis pub/sub  <── worker
                                                                          │
                                                                          ├─ imapflow (scan, test)
                                                                          └─ imapsync (execute)
```

## Security

- Admin password hashed with `argon2id`.
- IMAP credentials encrypted at rest with AES-256-GCM (`MASTER_KEY` env).
- JWT in httpOnly cookie.

**Backup `MASTER_KEY`** — losing it makes stored IMAP credentials unrecoverable.
