# model-check

Model availability checker focused on personal/self-hosted usage.

Repository: https://github.com/Moyucharm/model-check

## What Changed

- Default database is now **SQLite** (single file).
- Redis is now **optional**:
  - with `REDIS_URL`: BullMQ queue mode
  - without `REDIS_URL`: in-memory queue mode (single process)
- Dashboard history now shows the **latest 24 checks** per model.
- Model status now includes:
  - overall `healthy | partial | unhealthy | unknown`
  - per-endpoint latest status (Chat / Gemini CLI / Codex CLI / Claude CLI / Image)
- Dashboard view supports **List / Card** toggle (default: List).
- Proxy forwarding endpoints and proxy key management are removed (replaced by 404 routes).
- Public channel upload endpoint is removed (replaced by 404 route).

## Quick Start

```bash
npm install
cp .env.example .env
npm run db:push
npm run db:generate
npm run dev
```

Open: `http://localhost:3000`

## Environment

See `.env.example` for full settings.

Key variables:

- `DATABASE_URL=file:./data/model-check.db`
- `REDIS_URL=` (empty for in-memory queue)
- `CRON_SCHEDULE=0 * * * *`
- `ADMIN_PASSWORD`, `JWT_SECRET`

## Docker

```bash
docker compose up -d
```

With optional Redis profile:

```bash
COMPOSE_PROFILES=redis docker compose up -d
```

SQLite data is persisted under `./data`.

## API Notes

- Dashboard data endpoint: `GET /api/dashboard`
  - includes `healthStatus`, `endpointStatuses`, and 24 check logs
- Removed model proxy forwarding APIs:
  - `/v1/*`
  - `/v1beta/*`
- Removed proxy key APIs:
  - `/api/proxy-keys/*`
- Removed public upload API:
  - `/api/channel/public-upload`

## License

MIT
