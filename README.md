# Book to Kindle

> Say what you want to read. Let the workflow deliver it to your Kindle.

Book to Kindle is a lightweight, Cloudflare-first workflow for sending ebooks to Kindle with as little manual work as possible. The same codebase is designed to run either locally or on Cloudflare, so the workflow can keep working even when your PC is turned off.

## Goals

- **One intent, one workflow** — accept a book request from Telegram, Hermes, another AI agent, or a plain HTTP client.
- **Local or cloud** — use the same core workflow in local development and Cloudflare deployment.
- **Cloudflare Free friendly** — keep the always-on path inside Workers, Queues, D1 and R2 limits; move heavyweight conversion to optional local adapters.
- **Asynchronous by default** — HTTP requests enqueue work instead of blocking while files are fetched or delivered.
- **Provider-neutral** — discovery/download and delivery are adapter interfaces rather than hard-coded to one website or one email provider.
- **Legal-source first** — bundled providers should only target content the user is authorized to obtain; third-party source adapters are separate integrations.

## Architecture

```text
Telegram / Hermes / HTTP
          |
          v
  Cloudflare Worker
   API + Webhook
          |
          +----> D1 (task state)
          |
          v
       Queue
          |
          v
  Source Adapter
          |
          v
         R2  <-----------------------+
          |                           |
          v                           |
 Delivery Adapter                    |
   (Gmail API)                        |
          |                           |
          v                           |
       Kindle                         |
                                      |
Optional local enhancement node ------+
(Shelfmark / CWA / Calibre)
```

### Why this shape?

Cloudflare Workers are excellent as a lightweight always-on control plane, but they are not a Docker host and should not be treated like a VPS. Heavy ebook repair/conversion remains optional. If the requested file is already Kindle-compatible (for example EPUB or PDF), the Cloudflare path can complete the job without a PC.

## Current status

**v0.1.0 — architecture bootstrap / MVP skeleton**

Implemented in the initial skeleton:

- Cloudflare Worker HTTP API
- D1-backed task state
- Queue-based asynchronous task processing
- R2 temporary object storage binding
- provider/delivery adapter boundaries
- simple token authentication for API calls
- local execution through Wrangler
- initial D1 schema and project documentation

Not yet implemented:

- production Telegram webhook parsing
- Hermes MCP/Skill adapter
- production book discovery/download providers
- Gmail OAuth setup and attachment delivery
- optional Shelfmark/CWA/Calibre local enhancement adapter
- automatic source ranking and ambiguity confirmation

## API

### Create a task

```http
POST /api/v1/tasks
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{
  "query": "The Little Prince",
  "author": "Antoine de Saint-Exupéry",
  "language": "en",
  "preferredFormat": "epub"
}
```

Response:

```json
{
  "id": "...",
  "status": "queued"
}
```

### Check a task

```http
GET /api/v1/tasks/<id>
Authorization: Bearer <API_TOKEN>
```

### Health check

```http
GET /health
```

## Local development

Requirements:

- Node.js 20+
- npm

```bash
npm install
npm run db:migrate:local
npm run dev
```

Wrangler runs the Worker, D1, R2 and Queue bindings locally. This gives us a local deployment without maintaining a second backend implementation.

Create `.dev.vars`:

```dotenv
API_TOKEN=replace-with-a-long-random-value
KINDLE_EMAIL=your-kindle-address@kindle.com
```

## Cloudflare deployment

1. Create a D1 database and R2 bucket.
2. Create the Queue bindings described in `wrangler.toml`.
3. Replace placeholder IDs in `wrangler.toml`.
4. Add secrets with Wrangler:

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put KINDLE_EMAIL
```

5. Apply migrations and deploy:

```bash
npm run db:migrate:remote
npm run deploy
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) before deploying.

## Cloudflare Free design rules

The project deliberately follows these rules:

1. Keep request handlers short; enqueue long-running work.
2. Store ebook bytes in R2, never D1.
3. Put only task metadata/status in D1.
4. Avoid Docker/Calibre in the Cloudflare path.
5. Treat large conversion/repair as an optional local enhancement.
6. Delete temporary R2 objects after delivery unless retention is explicitly enabled.

## Repository layout

```text
src/
  index.ts              Worker entry point and queue consumer
  domain.ts             shared request/task types
  repository.ts         D1 task repository
  workflow.ts           platform-neutral orchestration
  adapters/             source and delivery adapters
migrations/             D1 schema migrations
docs/
  ARCHITECTURE.md        design decisions
  DEPLOYMENT.md          local + Cloudflare deployment
CHANGELOG.md             project history
```

## Roadmap

### v0.1 — Core workflow
- task API
- D1 state
- Queue execution
- R2 staging

### v0.2 — Kindle delivery
- Gmail OAuth
- Send-to-Kindle delivery
- delivery receipts and retry policy

### v0.3 — AI entry points
- Telegram webhook
- Hermes adapter
- book-title/author extraction
- ambiguity confirmation

### v0.4 — Source intelligence
- pluggable legal/public-domain providers
- format/language ranking
- duplicate and quality checks

### v0.5 — Optional local enhancement
- Shelfmark adapter
- Calibre/CWA processing node
- repair/convert fallback when Cloudflare cannot handle a file directly

## Security

- Secrets belong in Wrangler secrets / `.dev.vars`, never Git.
- API endpoints require a bearer token except `/health`.
- Download adapters must use explicit allowlists and validate content type/size before storing files.
- Temporary files should be removed after delivery.

## License

MIT. See [`LICENSE`](LICENSE).
