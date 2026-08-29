# Deployment

This project intentionally supports two execution modes from the same codebase.

## A. Local mode

Use local mode for development, testing, or running the workflow on a machine/NAS without deploying to Cloudflare.

### Requirements

- Node.js 20+
- npm

### Steps

```bash
git clone https://github.com/Felix8686/book-to-kindle.git
cd book-to-kindle
npm install
```

Create `.dev.vars`:

```dotenv
API_TOKEN=replace-with-a-long-random-secret
KINDLE_EMAIL=your-kindle-address@kindle.com
```

Apply the local D1 migration:

```bash
npm run db:migrate:local
```

Start the local Worker:

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:8787/health
```

Create a test task:

```bash
curl -X POST http://localhost:8787/api/v1/tasks \
  -H "Authorization: Bearer replace-with-a-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"query":"The Little Prince","language":"en","preferredFormat":"epub"}'
```

The initial v0.1 skeleton has no production source adapter yet, so a queued task will settle in `needs_source`. That is expected until v0.2+ adapters are enabled.

---

## B. Cloudflare mode

Cloudflare is the always-on deployment target. It does not require a VPS.

### 1. Authenticate Wrangler

```bash
npx wrangler login
```

### 2. Create D1

```bash
npx wrangler d1 create book-to-kindle
```

Copy the returned database ID into `wrangler.toml`.

### 3. Create R2 bucket

```bash
npx wrangler r2 bucket create book-to-kindle-files
```

### 4. Create queues

```bash
npx wrangler queues create book-to-kindle-tasks
npx wrangler queues create book-to-kindle-dlq
```

### 5. Configure secrets

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put KINDLE_EMAIL
```

Future Gmail delivery will add OAuth secrets. Do not place them in `wrangler.toml`.

### 6. Apply migration

```bash
npm run db:migrate:remote
```

### 7. Deploy

```bash
npm run deploy
```

### 8. Verify

```bash
curl https://<your-worker>.workers.dev/health
```

Then submit a task with the same API used in local mode.

---

## C. Optional local enhancement node

The future enhancement node is deliberately separate from the Worker runtime.

Expected responsibilities:

- Shelfmark integration;
- Calibre/CWA repair and conversion;
- processing files too large or expensive for the Cloudflare path.

The enhancement node should expose a narrow HTTP/pull-consumer contract. The core workflow should continue to function when the node is offline.

This gives the desired behavior:

- PC on: Cloudflare may delegate difficult tasks to the local node.
- PC off: Cloudflare still handles lightweight compatible files independently.

---

## D. Production checklist

Before exposing the service publicly:

- [ ] Replace the placeholder D1 database ID.
- [ ] Configure a strong `API_TOKEN`.
- [ ] Add production source adapters with domain allowlists.
- [ ] Add file-signature/content-type validation.
- [ ] Add Gmail OAuth delivery.
- [ ] Add Telegram webhook secret verification before enabling Telegram.
- [ ] Configure R2 lifecycle deletion as a second safety net for stale temporary files.
- [ ] Add structured error/attempt fields and dead-letter handling UI or commands.
