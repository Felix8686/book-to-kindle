# Book to Kindle

> Say what you want to read. Let the workflow deliver it to your Kindle.

Book to Kindle is a lightweight, Cloudflare-first workflow for sending ebooks to Kindle with as little manual work as possible. The same core codebase is designed to run locally or on Cloudflare, while the Cloudflare deployment can stay available even when the user's PC is turned off.

## Goals

- **One intent, one workflow** — accept a book request from Telegram, Hermes, another AI agent, or a plain HTTP client.
- **Local or cloud** — use the same core workflow in local development and Cloudflare deployment.
- **Cloudflare Free friendly** — keep the always-on path inside Workers, Queues, D1 and R2; move heavyweight conversion to optional local adapters.
- **Asynchronous by default** — HTTP and chat entrypoints enqueue work instead of blocking while files are fetched or delivered.
- **Provider-neutral** — discovery/download, delivery and user entrypoints are adapters rather than hard-coded into orchestration.
- **Legal-source first** — bundled providers only target content the user is authorized to obtain.

## Architecture

```text
                +-------------------+
Telegram ------>| Telegram adapter  |
Hermes -------->| HTTP/API adapter  |
Other clients ->|                   |
                +---------+---------+
                          |
                          v
                  Cloudflare Worker
                          |
                 +--------+--------+
                 |                 |
                 v                 v
                D1              Queue
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

Telegram talks directly to the Cloudflare Worker. Hermes is optional and is not required for the workflow to stay usable while the PC is off.

## Current status

**v0.3.0 — Telegram user entrypoint**

Implemented:

- Cloudflare Worker HTTP API
- D1-backed task state
- Queue-based asynchronous processing
- R2 temporary ebook staging
- deterministic candidate ranking
- ambiguity protection with persisted candidate lists
- built-in Gutendex / Project Gutenberg public-domain source adapter
- streaming file-size guardrail and EPUB/PDF signature validation
- Gmail OAuth Send-to-Kindle delivery
- persisted Gmail delivery receipts
- `delivery_unknown` duplicate-send protection
- **Telegram Bot webhook entrypoint**
- Telegram webhook secret validation
- Telegram user allowlist
- direct-title and natural-language requests
- `/send`, `/status`, `/whoami`, `/help`
- Telegram inline buttons for edition selection
- Telegram completion/error notifications
- local execution through Wrangler
- GitHub Actions TypeScript validation

Still planned:

- Hermes Skill/MCP adapter
- browser/share-sheet entry point
- optional Shelfmark/CWA/Calibre local enhancement node
- explicit user-controlled retry for uncertain deliveries
- additional authorized/public-domain source adapters

## Telegram usage

After Telegram is configured, the normal user experience is simply:

```text
把《Pride and Prejudice》发到 Kindle
```

or:

```text
Pride and Prejudice
```

The bot acknowledges the request, creates the same core task used by the HTTP API, and later reports the result.

If multiple plausible editions are found, Telegram displays inline buttons and the selected candidate resumes the **same task**.

Useful commands:

```text
/send <书名>
/status
/whoami
/help
```

EPUB is the default format preference. Add `PDF` to the request to prefer PDF.

Full setup: [`docs/TELEGRAM.md`](docs/TELEGRAM.md).

## HTTP API

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

### Check a task

```http
GET /api/v1/tasks/<id>
Authorization: Bearer <API_TOKEN>
```

Important states:

- `delivered` — Gmail accepted the message
- `delivery_unknown` — Gmail delivery started but the final outcome could not be confirmed; automatic resend is blocked
- `needs_selection` — several plausible editions were found
- `needs_source` — no compatible bundled source was found
- `failed` — processing failed before delivery was known to have started

### Resolve an ambiguous match

```http
POST /api/v1/tasks/<id>/select
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{
  "candidateId": "gutenberg:1342:epub"
}
```

Telegram users do not need to call this endpoint manually; the inline selection buttons use the same state transition internally.

### Health check

```http
GET /health
```

The health response reports source, Gmail and Telegram configuration state without exposing secrets.

## Telegram security model

The Telegram webhook endpoint is:

```text
POST /telegram/webhook
```

It does **not** use the normal `API_TOKEN`. Instead it verifies Telegram's webhook secret header:

```text
X-Telegram-Bot-Api-Secret-Token
```

Required Telegram configuration:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
TELEGRAM_ALLOWED_USER_IDS
```

Security defaults:

- only private chats are accepted;
- `/whoami` is available before allowlist setup so the owner can discover their numeric Telegram user ID;
- task creation is denied until an explicit allowlist exists;
- candidate selection callbacks must match both the original Telegram user and original chat;
- Telegram task/chat mapping is stored separately from the core task model.

## Local development

Requirements:

- Node.js 20+
- npm

```bash
npm install
npm run db:migrate:local
npm run dev
```

Example `.dev.vars`:

```dotenv
API_TOKEN=replace-with-a-long-random-value
KINDLE_EMAIL=your-kindle-address@kindle.com
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_FROM_EMAIL=your-gmail-address@gmail.com
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

Telegram itself requires a public HTTPS webhook URL, so local Telegram webhook testing needs a secure tunnel or temporary deployed Worker. The normal HTTP API remains locally testable without a tunnel.

## Cloudflare deployment

1. Create D1, R2, task queue and dead-letter queue.
2. Replace the D1 placeholder ID in `wrangler.toml`.
3. Store credentials with Wrangler secrets.
4. Apply all migrations, including `0004_telegram_entry.sql`.
5. Deploy.
6. Register the Telegram webhook.

```bash
npm install
npm run db:migrate:remote
npm run deploy
```

Detailed deployment: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Telegram setup: [`docs/TELEGRAM.md`](docs/TELEGRAM.md).

Gmail OAuth setup: [`docs/GMAIL_OAUTH.md`](docs/GMAIL_OAUTH.md).

## Cloudflare Free design rules

1. Keep HTTP/webhook request handlers short and enqueue long-running work.
2. Store ebook bytes in R2, never D1.
3. Put only task metadata/status and lightweight entrypoint mappings in D1.
4. Avoid Docker/Calibre/native binaries in the Cloudflare core path.
5. Stream downloads and delivery rather than buffering entire books when possible.
6. Reject files above the configured cloud-path threshold.
7. Delete temporary R2 objects after confirmed delivery; cleanup failure must not turn a successful delivery into a failed task.

The default cloud-path threshold is currently **20 MiB**.

## Built-in source

The first bundled provider is **Gutendex**, an API over Project Gutenberg metadata. The adapter:

- requests entries marked `copyright=false` by Gutendex;
- supports title/author search and language filtering;
- exposes EPUB/PDF candidates;
- prefers Project Gutenberg's standard no-images EPUB variant for the cloud path;
- only follows HTTPS downloads hosted under `gutenberg.org`;
- validates EPUB/PDF file signatures before R2 staging.

Copyright status varies by jurisdiction. Users remain responsible for ensuring they are allowed to obtain and use a specific file.

## Gmail / Kindle delivery

The delivery adapter uses Gmail OAuth with the `gmail.send` scope. It refreshes a short-lived access token when needed, creates a MIME message, streams the staged ebook into it, and sends it through Gmail's media-upload endpoint.

Required secrets:

```text
KINDLE_EMAIL
GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET
GMAIL_REFRESH_TOKEN
GMAIL_FROM_EMAIL
```

The Gmail sender must also be allowed by the user's Amazon Send to Kindle settings.

## Repository layout

```text
src/
  index.ts                  Worker entry point + HTTP API + queue consumer
  telegram.ts               Telegram webhook, commands, buttons, notifications
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
  0004_telegram_entry.sql
docs/
  ARCHITECTURE.md
  DEPLOYMENT.md
  GMAIL_OAUTH.md
  TELEGRAM.md
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

### v0.3 — User entrypoint
- Telegram webhook
- natural-language book requests
- chat status notifications
- inline ambiguity confirmation
- Telegram user authorization

### v0.4 — Additional entrypoints and source intelligence
- Hermes Skill/MCP bridge
- browser/share-sheet bridge
- additional authorized/public-domain providers
- stronger metadata matching

### v0.5 — Optional local enhancement
- Shelfmark adapter
- Calibre/CWA processing node
- repair/convert fallback for files Cloudflare should not process

## Security

- Secrets belong in Wrangler secrets / `.dev.vars`, never Git.
- HTTP task APIs require a bearer token except `/health`.
- Telegram webhook calls require the Telegram webhook secret header.
- Telegram task creation requires an explicit user allowlist.
- Bundled download adapters use explicit host allowlists.
- File type, signature and size are validated before staging.
- Temporary files are removed after confirmed delivery.
- Automatic resend is blocked when delivery outcome is uncertain.

## License

MIT. See [`LICENSE`](LICENSE).
