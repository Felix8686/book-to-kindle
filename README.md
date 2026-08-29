# Book to Kindle

> Say what you want to read. Let the workflow deliver it to your Kindle.

Book to Kindle is a lightweight, Cloudflare-first workflow for sending ebooks to Kindle with as little manual work as possible. The same codebase is designed to run locally or on Cloudflare, so the workflow can keep working even when your PC is turned off.

## Goals

- **One intent, one workflow** — accept a book request from Telegram, Hermes, another AI agent, or a plain HTTP client.
- **Local or cloud** — use the same core workflow in local development and Cloudflare deployment.
- **Cloudflare Free friendly** — keep the always-on path inside Workers, Queues, D1 and R2; move heavyweight conversion to optional local adapters.
- **Asynchronous by default** — HTTP requests enqueue work instead of blocking while files are fetched or delivered.
- **Provider-neutral** — discovery/download and delivery are adapter interfaces rather than hard-coded into orchestration.
- **Legal-source first** — bundled providers only target content the user is authorized to obtain.

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
   (Gutendex)
          |
          v
         R2
          |
          v
 Delivery Adapter
   (Gmail API)
          |
          v
       Kindle

Optional local enhancement node
(Shelfmark / CWA / Calibre)
```

Cloudflare is the always-on control plane, not a VPS replacement. Heavy ebook repair/conversion remains optional. If a requested file is already Kindle-compatible, the Cloudflare path can complete the job without a PC.

## Current status

**v0.2.1 — first end-to-end cloud path with conservative delivery idempotency**

Implemented:

- Cloudflare Worker HTTP API
- D1-backed task state
- Queue-based asynchronous processing
- R2 temporary ebook staging
- deterministic candidate ranking
- ambiguity protection with persisted candidate lists
- manual candidate-selection endpoint
- built-in Gutendex / Project Gutenberg public-domain source adapter
- Project Gutenberg download-domain allowlist
- streaming file-size guardrail
- EPUB/PDF signature validation across stream chunks
- Gmail OAuth refresh-token flow
- Gmail `message/rfc822` media-upload delivery
- persisted Gmail delivery receipt (`messageId`, `threadId`, accepted timestamp)
- `delivery_unknown` safety state when Gmail outcome cannot be confirmed
- duplicate-send protection for uncertain deliveries
- local execution through Wrangler
- GitHub Actions TypeScript validation

Still planned:

- Telegram webhook entry point
- Hermes Skill/MCP adapter
- browser/share-sheet entry point
- optional Shelfmark/CWA/Calibre local enhancement node
- explicit user-controlled retry for uncertain deliveries
- additional authorized/public-domain source adapters

## API

### Create a task

```http
POST /api/v1/tasks
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{
  "query": "Pride and Prejudice",
  "author": "Jane Austen",
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

Important states:

- `delivered` — Gmail accepted the message; a delivery receipt is stored when available
- `delivery_unknown` — Gmail delivery started but the final outcome could not be confirmed; automatic resend is blocked
- `needs_selection` — several plausible editions were found
- `needs_source` — no compatible public-domain source was found
- `failed` — processing failed before delivery was known to have started

### Resolve an ambiguous match

When a task returns `needs_selection`, its response includes a ranked `candidates` array. Select one by ID:

```http
POST /api/v1/tasks/<id>/select
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{
  "candidateId": "gutenberg:1342:epub"
}
```

The task is then re-queued and continues from download.

### Health check

```http
GET /health
```

The health response reports whether Gmail delivery is configured, without exposing secrets.

## Local development

Requirements:

- Node.js 20+
- npm

```bash
npm install
npm run db:migrate:local
npm run dev
```

Create `.dev.vars`:

```dotenv
API_TOKEN=replace-with-a-long-random-value
KINDLE_EMAIL=your-kindle-address@kindle.com
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_FROM_EMAIL=your-gmail-address@gmail.com
```

See [`docs/GMAIL_OAUTH.md`](docs/GMAIL_OAUTH.md) for Gmail setup.

## Cloudflare deployment

1. Create a D1 database, R2 bucket, task queue and dead-letter queue.
2. Replace the D1 placeholder ID in `wrangler.toml`.
3. Store credentials with Wrangler secrets.
4. Apply all migrations.
5. Deploy.

```bash
npm install
npm run db:migrate:remote
npm run deploy
```

Detailed steps are in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Cloudflare Free design rules

1. Keep HTTP request handlers short and enqueue long-running work.
2. Store ebook bytes in R2, never D1.
3. Put only task metadata/status in D1.
4. Avoid Docker/Calibre/native binaries in the Cloudflare core path.
5. Stream downloads and delivery rather than buffering entire books in memory.
6. Reject files above the configured cloud-path threshold.
7. Delete temporary R2 objects after confirmed delivery; cleanup failure must not change a successful delivery into a failed task.

The default cloud-path threshold is currently **20 MiB**. Gmail personal accounts have a 25 MB attachment ceiling, so the project leaves headroom instead of targeting that limit directly.

## Built-in source

The first bundled provider is **Gutendex**, an API over Project Gutenberg metadata. The adapter:

- requests only entries marked `copyright=false` by Gutendex;
- supports title/author search and language filtering;
- exposes EPUB/PDF candidates;
- only follows HTTPS downloads hosted under `gutenberg.org`;
- validates EPUB/PDF file signatures before R2 staging.

Copyright status varies by jurisdiction. Users remain responsible for ensuring they are allowed to obtain and use a specific file.

## Gmail / Kindle delivery

The delivery adapter uses Gmail OAuth with the `gmail.send` scope. It refreshes a short-lived access token only when needed, creates a MIME message, streams the staged ebook into it, and sends it through Gmail's media-upload endpoint.

Required secrets:

```text
KINDLE_EMAIL
GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET
GMAIL_REFRESH_TOKEN
GMAIL_FROM_EMAIL
```

The Gmail sender must also be allowed by the user's Amazon Send to Kindle settings.

A confirmed Gmail response is stored as `deliveryReceipt`. If delivery starts but the outcome is uncertain, the task becomes `delivery_unknown` and is not automatically resent.

## Repository layout

```text
src/
  index.ts                  Worker entry point + API + queue consumer
  domain.ts                 shared request/task/adapter types
  repository.ts             D1 task repository
  workflow.ts               platform-neutral orchestration
  adapters/
    gutendex.ts              public-domain search/download adapter
    gmail.ts                 Gmail Send-to-Kindle delivery adapter
migrations/
  0001_init.sql
  0002_candidates.sql
  0003_delivery_receipt.sql
docs/
  ARCHITECTURE.md
  DEPLOYMENT.md
  GMAIL_OAUTH.md
  REPOSITORY_METADATA.md
CHANGELOG.md
```

## Roadmap

### v0.1 — Core workflow
- task API
- D1 state
- Queue execution
- R2 staging

### v0.2 — Real cloud path
- Gutendex / Project Gutenberg adapter
- candidate confirmation endpoint
- Gmail OAuth delivery
- streaming upload and file validation
- delivery receipts and duplicate-send protection

### v0.3 — AI entry points
- Telegram webhook
- Hermes adapter
- natural-language book request extraction
- ambiguity confirmation through chat

### v0.4 — Source intelligence
- additional authorized/public-domain providers
- duplicate/edition quality checks
- stronger metadata matching

### v0.5 — Optional local enhancement
- Shelfmark adapter
- Calibre/CWA processing node
- repair/convert fallback for files Cloudflare should not process

## Security

- Secrets belong in Wrangler secrets / `.dev.vars`, never Git.
- API endpoints require a bearer token except `/health`.
- Bundled download adapters use explicit host allowlists.
- File type, signature and size are validated before staging.
- Temporary files are removed after confirmed delivery.
- Automatic resend is blocked when delivery outcome is uncertain, reducing duplicate Kindle documents.

## License

MIT. See [`LICENSE`](LICENSE).
