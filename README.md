# Book to Kindle

> Say it, type it, or show the cover. Let the workflow deliver the book to Kindle.

Book to Kindle is a lightweight, Cloudflare-first workflow for sending ebooks to Kindle with minimal manual work. The same core workflow can run locally or on Cloudflare; the Cloudflare deployment stays available even when the user's PC and Hermes are offline.

## What it does

You can currently request a book through:

- Telegram text;
- Telegram book-cover/photo/screenshot;
- the HTTP API;
- future adapters such as Hermes or a share sheet.

The v0.5 cloud path is:

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
                         +------------+-------------+
                         | Work/edition resolution  |
                         | Open Library + Google    |
                         +------------+-------------+
                                      |
                                      v
                         Multi-source candidate search
                         | Gutendex / Gutenberg
                         | Google Books Free
                         | Internet Archive Public
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

**v0.5.1 — language preferences, multi-source discovery and cancellation/Queue reliability fixes**

Implemented:

- Cloudflare Worker HTTP API;
- D1 task state;
- Queue-based asynchronous processing;
- R2 temporary ebook staging;
- Gmail OAuth Send-to-Kindle delivery and receipts;
- conservative `delivery_unknown` duplicate-send protection;
- Telegram webhook with secret validation, allowlist and private-chat restriction;
- text, natural-language and image requests;
- Cloudflare Workers AI vision recognition;
- `/send`, `/status`, `/cancel`, `/settings`, `/language`, `/whoami`, `/help`;
- Chinese `取消` / `撤回` cancellation commands;
- authenticated HTTP cancellation endpoint;
- persistent Telegram language preference with **Chinese preferred by default**;
- one-off `中文` / `英文` request override without changing the saved preference;
- Open Library + Google Books work/edition resolution;
- cross-language edition-title discovery without blindly machine-translating the title;
- multi-source download search;
- Gutendex / Project Gutenberg source;
- Google Books Free source;
- Internet Archive public-access source;
- cross-source normalization, ranking and deduplication;
- edition-safe fallback deduplication when no shared ISBN is available;
- Queue-enqueue recovery without leaving Telegram-created tasks stuck in `queued`;
- GitHub Actions TypeScript validation.

Still planned:

- Hermes Skill/MCP adapter;
- optional Amazon catalog resolver using supported API credentials;
- browser/share-sheet entrypoint;
- more verified public/open-access source adapters;
- explicit user-controlled retry for uncertain deliveries;
- optional Shelfmark/CWA/Calibre enhancement node.

## Language preference

New Telegram users start with:

```text
默认书籍语言：中文优先
默认格式：EPUB
```

The priority is:

```text
language explicitly requested in this message
> saved Telegram user language
> system default zh
```

`zh` is a preference, not a hard filter. If the resolver/download sources cannot find a suitable Chinese edition, the workflow may fall back to another language instead of immediately returning `needs_source`.

Commands:

```text
/settings
/language zh
/language en
/语言 中文
/语言 英文
```

Example: if the saved default is Chinese, this request is English-only for this task:

```text
Thinking, Fast and Slow 英文
```

The next task returns to the saved Chinese preference.

## Work and edition resolution

Before querying download sources, the queue worker resolves a lightweight canonical identity.

Enabled metadata resolvers:

- **Open Library** — work IDs, authors, ISBNs and language-specific editions;
- **Google Books** — title/author/language/ISBN confirmation and additional volume metadata.

For the best Open Library work, v0.5 inspects edition metadata so an English input title can discover a known Chinese edition title when one exists. It does not treat an AI translation of the English title as proof that a Chinese edition exists.

Detailed source design: [`docs/SOURCES.md`](docs/SOURCES.md).

## Download sources

Enabled `SourceAdapter`s:

```text
GutendexSource
GoogleBooksFreeSource
InternetArchivePublicSource
```

The workflow searches sources independently and uses normalized scoring rather than whichever source responds first.

Google Books candidates must be full/free downloadable volumes with an actual EPUB/PDF download link. Internet Archive candidates must be Open Library `ebook_access=public` records with non-restricted/non-private EPUB/PDF files.

Standard Ebooks and OAPEN remain desirable future sources, but are not default dependencies until a stable anonymous machine-access contract is verified for the project. See [`docs/SOURCES.md`](docs/SOURCES.md).

## Telegram usage

### Text

```text
把《Pride and Prejudice》发到 Kindle
```

or simply:

```text
Pride and Prejudice
```

Prefer PDF for one task:

```text
《The Little Prince》 PDF
```

Useful commands:

```text
/send <书名>
/status
/settings
/language zh
/language en
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

Send the bot a clear book cover, physical-book photo, reading-app/bookstore screenshot, or screenshot containing several books.

For a clear single cover, the bot can continue automatically. If several books are visible or confidence is low, the bot sends inline buttons and waits for selection.

Image captions such as `PDF`, `中文` or `英文` override that task's preferences. If no language is in the caption, the saved user default applies after vision identifies the work.

Full Telegram setup: [`docs/TELEGRAM.md`](docs/TELEGRAM.md).

## Cancellation semantics

These states can still be cancelled:

```text
queued
searching
needs_source
needs_selection
downloading
staged
```

A successful cancellation is persisted as `cancelled`.

Once the task has entered any of these states, the service will not claim it can withdraw the document:

```text
delivering
delivery_unknown
delivered
```

The Queue workflow re-checks cancellation around resolution, source search, download, R2 staging and the final Gmail boundary. If cancellation wins while a file is being staged, the temporary R2 object is deleted best-effort and delivery does not continue.

Detailed behavior: [`docs/CANCELLATION.md`](docs/CANCELLATION.md).

## Why image recognition is asynchronous

The Telegram webhook does not run vision inference itself. It validates the request and enqueues a lightweight `telegram_image` job.

The Queue consumer then downloads the bounded image and calls Cloudflare Workers AI. Current vision model:

```text
@cf/meta/llama-3.2-11b-vision-instruct
```

The Worker uses the `AI` binding configured in `wrangler.toml`. Before first production use, the Cloudflare account must accept the model's Meta license/AUP once.

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

The image path requires an authorized user, checks declared/downloaded size, validates the actual file signature, does not persist the original image in R2/D1, and does not automatically retry failed vision inference.

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

If `language` is omitted, the system default is Chinese preferred for non-Telegram tasks. A Telegram task with no explicit language uses that user's saved setting first.

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
- `needs_source` — no compatible enabled download source was found;
- `failed` — processing failed before delivery was known to have started.

### Cancel a task

```http
POST /api/v1/tasks/<id>/cancel
Authorization: Bearer <API_TOKEN>
```

### Resolve source ambiguity

```http
POST /api/v1/tasks/<id>/select
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{
  "candidateId": "gutenberg:1342:epub"
}
```

## Health

```http
GET /health
```

v0.5 reports the active resolver/source set, including:

```json
{
  "resolvers": ["openlibrary", "google-books"],
  "sources": ["gutendex", "google-books-free", "internet-archive-public"],
  "defaultLanguage": "zh",
  "vision": "workers_ai"
}
```

## Cloudflare deployment

The repository uses Workers, Workers AI, D1, R2 and Queues.

Apply all migrations before deploying:

```text
0001_init.sql
0002_candidates.sql
0003_delivery_receipt.sql
0004_telegram_entry.sql
0005_telegram_update_idempotency.sql
0006_telegram_image_choices.sql
0007_user_settings.sql
```

Then:

```bash
npm install
npm run typecheck
npm run db:migrate:remote
npm run deploy
```

Cancellation uses the existing free-form `tasks.status` column and needs no separate migration.

Detailed deployment: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Gmail OAuth: [`docs/GMAIL_OAUTH.md`](docs/GMAIL_OAUTH.md).

Telegram setup: [`docs/TELEGRAM.md`](docs/TELEGRAM.md).

Sources/resolution: [`docs/SOURCES.md`](docs/SOURCES.md).

## Cloudflare-first design rules

1. Keep HTTP/webhook handlers short.
2. Put network-heavy/AI work behind Queue.
3. Store ebook bytes in R2, never D1.
4. Keep D1 to lightweight task/entry/recognition/settings metadata.
5. Do not persist source images unnecessarily.
6. Keep strict ebook/image size guardrails.
7. Avoid Docker, Calibre and native binaries in the cloud core path.
8. Isolate resolver/source failures so one provider cannot stop the whole search.
9. Do not blindly resend after an uncertain Gmail delivery.
10. Do not pretend that an already-started Gmail/Kindle delivery can be recalled.
11. Keep Hermes optional rather than a required cloud relay.

## Repository layout

```text
src/
  index.ts                     Worker/API/Queue entrypoint
  domain.ts                    shared types
  repository.ts                core D1 task repository
  resolver.ts                  Open Library + Google Books work resolver
  settings.ts                  persistent Telegram language settings
  workflow.ts                  resolution/search/delivery orchestration
  telegram.ts                  Telegram text/image adapter
  cancel.ts                    cancellation controls
  adapters/
    gutendex.ts                 Project Gutenberg source
    googlebooks.ts              Google Books free/full source
    internetarchive.ts          Internet Archive public source
    gmail.ts                    Gmail Send-to-Kindle delivery
migrations/
  0001_init.sql
  0002_candidates.sql
  0003_delivery_receipt.sql
  0004_telegram_entry.sql
  0005_telegram_update_idempotency.sql
  0006_telegram_image_choices.sql
  0007_user_settings.sql
docs/
  ARCHITECTURE.md
  CANCELLATION.md
  DEPLOYMENT.md
  GMAIL_OAUTH.md
  SOURCES.md
  TELEGRAM.md
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
Book covers/screenshots -> Workers AI -> normal book workflow, plus safe task cancellation.

### v0.5 — Language + multi-source discovery
Persistent Chinese-first language preference, cross-language edition resolution and multiple verified download sources.

### Next
- Hermes adapter;
- optional Amazon catalog resolver;
- additional verified open-access sources;
- browser/share-sheet entry;
- optional local repair/conversion node.

## License

MIT. See [`LICENSE`](LICENSE).
