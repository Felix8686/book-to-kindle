# Book to Kindle

> Say it, type it, or show the cover. Let the workflow deliver the book to Kindle.

Book to Kindle is a lightweight, Cloudflare-first workflow for sending ebooks to Kindle with minimal manual work. The same core workflow can run locally or on Cloudflare; the Cloudflare deployment stays available even when the user's PC and Hermes are offline.

## What it does

You can currently request a book through:

- Telegram text;
- Telegram book-cover/photo/screenshot;
- the HTTP API;
- future adapters such as Hermes or a share sheet.

The normal cloud path is:

```text
Telegram text -----------------------+
                                      |
Telegram image -> Queue -> Workers AI+--> BookRequest
                                      |
HTTP / future Hermes ----------------+
                                      |
                                      v
                                     D1
                                      |
                                      v
                                    Queue
                                      |
                                      v
                           Gutendex / Project Gutenberg
                                      |
                                      v
                                     R2
                                      |
                                      v
                                  Gmail API
                                      |
                                      v
                                    Kindle
```

Heavy repair/conversion tools such as Shelfmark, Calibre or CWA are deliberately excluded from the Cloudflare core path and remain optional future local enhancements.

## Current status

**v0.4.0 — Telegram image recognition**

Implemented:

- Cloudflare Worker HTTP API;
- D1 task state;
- Queue-based asynchronous processing;
- R2 temporary ebook staging;
- Gutendex / Project Gutenberg public-domain source adapter;
- deterministic edition ranking and ambiguity protection;
- Gmail OAuth Send-to-Kindle delivery;
- Gmail delivery receipts;
- conservative `delivery_unknown` duplicate-send protection;
- Telegram webhook with secret validation;
- Telegram user allowlist and private-chat restriction;
- direct-title and lightweight natural-language requests;
- `/send`, `/status`, `/cancel`, `/whoami`, `/help`;
- Chinese `取消` / `撤回` cancellation commands;
- authenticated HTTP cancellation endpoint;
- Telegram inline buttons for source-edition selection;
- Telegram completion/error notifications;
- **Telegram photo and image-document input**;
- **Cloudflare Workers AI vision recognition**;
- automatic book-title/author extraction from clear covers;
- inline book-selection buttons for multi-book or uncertain images;
- image caption preferences such as `PDF`, `中文`, `英文`;
- JPEG/PNG/WebP validation and strict image-size limits;
- GitHub Actions TypeScript validation.

Still planned:

- Hermes Skill/MCP adapter;
- browser/share-sheet entrypoint;
- additional authorized/public-domain source adapters;
- explicit user-controlled retry for uncertain deliveries;
- optional Shelfmark/CWA/Calibre enhancement node.

## Telegram usage

### Text

```text
把《Pride and Prejudice》发到 Kindle
```

or simply:

```text
Pride and Prejudice
```

Prefer PDF:

```text
《The Little Prince》 PDF
```

Useful commands:

```text
/send <书名>
/status
/cancel
/cancel <task-id>
/whoami
/help
```

You can also send:

```text
取消
```

or:

```text
撤回
```

`/cancel` targets the most recent Telegram-linked task that is still safely cancellable. A task cannot be truthfully recalled once Gmail delivery has already started.

### Image

Send the bot a clear:

- book cover;
- photo of a physical book;
- reading-app/bookstore screenshot;
- screenshot containing several books.

For a clear single cover, the bot can continue automatically:

```text
收到图片，正在识别书名和作者……

识别到《Pride and Prejudice》（Jane Austen），开始查找并发送到 Kindle。
```

If the image contains several books or confidence is low, the bot sends inline buttons and waits for your selection before creating the normal book task.

You can add a caption such as:

```text
PDF
```

or:

```text
英文 EPUB
```

Those preferences survive the recognition/selection step.

Full Telegram setup: [`docs/TELEGRAM.md`](docs/TELEGRAM.md).

## Cancellation semantics

Cancellation is intentionally conservative.

These states can still be cancelled:

```text
queued
searching
needs_source
needs_selection
downloading
staged
```

A successful cancellation becomes:

```text
cancelled
```

Once the task has entered any of these states, the service will not claim it can withdraw the document:

```text
delivering
delivery_unknown
delivered
```

The Queue workflow re-checks cancellation around search, download, R2 staging, and the final Gmail boundary. If cancellation wins while a file is being staged, the temporary R2 object is deleted best-effort and delivery does not continue.

HTTP clients can use:

```http
POST /api/v1/tasks/<id>/cancel
Authorization: Bearer <API_TOKEN>
```

Detailed behavior: [`docs/CANCELLATION.md`](docs/CANCELLATION.md).

## Why image recognition is asynchronous

The Telegram webhook does not run vision inference itself. It only validates the request and enqueues a lightweight `telegram_image` job.

The Queue consumer then downloads the bounded image and calls Cloudflare Workers AI. This keeps the webhook fast and preserves the Cloudflare-first architecture.

Current vision model:

```text
@cf/meta/llama-3.2-11b-vision-instruct
```

The Worker uses an `AI` binding configured in `wrangler.toml`. Before first production use, the Cloudflare account must accept the model's Meta license/AUP once.

## Image safety / resource guardrails

Default:

```toml
MAX_TELEGRAM_IMAGE_BYTES = "4194304"
```

This is 4 MiB. Code also enforces a hard 6 MiB ceiling.

Supported image formats:

- JPEG;
- PNG;
- WebP.

The image path:

1. requires an authorized Telegram user;
2. checks Telegram-declared and downloaded size;
3. validates the actual file signature;
4. performs Workers AI inference;
5. does **not** persist the original image in R2 or D1;
6. does not automatically retry a failed vision job, avoiding duplicate inference cost/buttons/tasks.

Workers AI has a free daily allocation, so this path is designed for lightweight personal use rather than bulk image processing.

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

- `cancelled` — the user cancelled before Gmail delivery began;
- `delivered` — Gmail accepted the message;
- `delivery_unknown` — delivery started but the final outcome is unknown, so automatic resend is blocked;
- `needs_selection` — source edition needs confirmation;
- `needs_source` — no compatible bundled source was found;
- `failed` — processing failed before delivery was known to have started.

### Cancel a task

```http
POST /api/v1/tasks/<id>/cancel
Authorization: Bearer <API_TOKEN>
```

The endpoint returns a conflict if Gmail delivery has already begun or completed.

### Resolve source ambiguity

```http
POST /api/v1/tasks/<id>/select
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{
  "candidateId": "gutenberg:1342:epub"
}
```

Telegram users normally use inline buttons instead of this endpoint.

### Health

```http
GET /health
```

A fully configured v0.4 deployment reports source/delivery/Telegram status and:

```json
{
  "vision": "workers_ai"
}
```

## Telegram security

The webhook endpoint is:

```text
POST /telegram/webhook
```

It verifies Telegram's:

```text
X-Telegram-Bot-Api-Secret-Token
```

Required Telegram secrets:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
TELEGRAM_ALLOWED_USER_IDS
```

Security defaults:

- only private chats are accepted;
- `/whoami` remains available before allowlist setup;
- task/image processing is denied until an explicit allowlist exists;
- source and image selection callbacks verify the original user and chat;
- targeted `/cancel <task-id>` verifies that the task belongs to the same Telegram user;
- Telegram metadata lives outside the core task model;
- Telegram file URLs are generated internally from Telegram `file_id` values.

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

Telegram requires a public HTTPS webhook, so live Telegram testing needs a secure tunnel or a deployed Worker.

## Cloudflare deployment

The repository uses:

- Workers;
- Workers AI;
- D1;
- R2;
- Queues.

Apply all migrations before deploying:

```text
0001_init.sql
0002_candidates.sql
0003_delivery_receipt.sql
0004_telegram_entry.sql
0005_telegram_update_idempotency.sql
0006_telegram_image_choices.sql
```

Cancellation uses the existing free-form `tasks.status` column and therefore needs no extra migration.

Then:

```bash
npm install
npm run typecheck
npm run db:migrate:remote
npm run deploy
```

For image input, also accept the Meta vision-model license/AUP once on the Cloudflare account before testing.

Detailed deployment: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Gmail OAuth: [`docs/GMAIL_OAUTH.md`](docs/GMAIL_OAUTH.md).

Telegram + image setup: [`docs/TELEGRAM.md`](docs/TELEGRAM.md).

Cancellation behavior: [`docs/CANCELLATION.md`](docs/CANCELLATION.md).

## Cloudflare-first design rules

1. Keep HTTP/webhook handlers short.
2. Put network-heavy/AI work behind Queue.
3. Store ebook bytes in R2, never D1.
4. Keep D1 to lightweight task/entry/recognition metadata.
5. Do not persist source images unnecessarily.
6. Keep strict ebook/image size guardrails.
7. Avoid Docker, Calibre and native binaries in the cloud core path.
8. Do not blindly resend after an uncertain Gmail delivery.
9. Do not pretend that an already-started Gmail/Kindle delivery can be recalled.
10. Keep Hermes optional rather than a required cloud relay.

## Repository layout

```text
src/
  index.ts                  Worker/API/Queue entrypoint
  domain.ts                 shared types and queue message contracts
  repository.ts             core D1 task repository
  workflow.ts               book workflow orchestration
  telegram.ts               Telegram text/image adapter
  cancel.ts                 Telegram/HTTP cancellation controls
  adapters/
    gutendex.ts              public-domain discovery/download
    gmail.ts                 Gmail Send-to-Kindle delivery
migrations/
  0001_init.sql
  0002_candidates.sql
  0003_delivery_receipt.sql
  0004_telegram_entry.sql
  0005_telegram_update_idempotency.sql
  0006_telegram_image_choices.sql
docs/
  ARCHITECTURE.md
  CANCELLATION.md
  DEPLOYMENT.md
  GMAIL_OAUTH.md
  TELEGRAM.md
  REPOSITORY_METADATA.md
CHANGELOG.md
```

## Roadmap

### v0.1 — Core workflow
Task API, D1, Queue and R2 staging.

### v0.2 — Real cloud delivery
Public-domain source, Gmail delivery, receipts and delivery safety.

### v0.3 — Telegram text entry
Direct Telegram requests, selection buttons and notifications.

### v0.4 — Telegram vision entry
Book covers/screenshots -> Workers AI -> normal book workflow, plus safe task cancellation before Gmail delivery begins.

### Next
- Hermes adapter;
- more authorized/public-domain sources;
- browser/share-sheet entry;
- optional local repair/conversion node.

## License

MIT. See [`LICENSE`](LICENSE).