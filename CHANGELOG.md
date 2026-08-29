# Changelog

All notable changes to this project will be documented in this file.

The project follows Semantic Versioning while it is practical to do so.

## [Unreleased]

### Planned
- Hermes Skill/MCP bridge
- browser/share-sheet entry point
- optional Shelfmark/CWA/Calibre enhancement node
- explicit user-controlled retry for uncertain deliveries
- optional Amazon catalog resolver using supported API credentials
- additional verified public/open-access source adapters

## [0.5.1] - 2026-08-29

### Fixed
- preserve distinct editions when candidates do not share an ISBN instead of collapsing them solely by title, author, language and format
- prevent a source-selection callback racing with cancellation from enqueueing work or reporting that sending will continue
- remove incomplete Telegram tasks and release the update claim when Queue enqueue fails, allowing Telegram's retry to recover safely

## [0.5.0] - 2026-08-29

### Added
- persistent Telegram user settings in D1 via `0007_user_settings.sql`
- system default book language set to Chinese preferred (`zh`)
- `/settings`, `/language zh`, `/language en`, `/语言 中文`, and `/语言 英文`
- one-request language override without changing the saved default
- language preference applied to both text and image-originated book tasks
- Open Library work/edition resolver
- Google Books metadata resolver
- cross-language edition-title discovery without blind machine translation
- canonical work identity containing titles, authors, ISBNs, Open Library work keys and Google volume IDs
- Google Books Free download adapter
- Internet Archive public-access download adapter
- multi-source candidate normalization, scoring and cross-provider deduplication
- resolver/source inventory in `/health`
- dedicated `docs/SOURCES.md`

### Changed
- source search now receives a resolved `BookSearchContext` rather than only the raw user string
- Gutendex searches multiple resolved title variants instead of a single literal title
- language is a ranking preference rather than a hard filter, allowing fallback when a preferred-language file is unavailable
- source failures use isolated `Promise.allSettled` behavior so one provider cannot stop the whole search
- source order no longer determines the winner; candidate scoring combines identity, ISBN, author, language, format and source quality
- duplicate editions returned by multiple sources are collapsed before Telegram selection
- version bumped to `0.5.0`

### Source policy
- `gutendex` remains restricted to Project Gutenberg public-domain records
- `google-books-free` only emits full/free volumes with actual EPUB/PDF download links
- `internet-archive-public` only emits Open Library records marked `ebook_access=public`, then rejects restricted/private Archive files
- Standard Ebooks is documented but not enabled by default because its searchable OPDS catalog currently requires membership/project access
- OAPEN is documented as a future adapter pending a stable verified machine API contract
- Amazon remains an optional metadata enhancement and is not scraped or required

## [0.4.0] - 2026-08-29

### Added
- Telegram photo/image-document input for book requests
- asynchronous Telegram image recognition through the existing Cloudflare Queue
- Cloudflare Workers AI binding for `@cf/meta/llama-3.2-11b-vision-instruct`
- structured vision extraction of book title, author, apparent language and confidence
- automatic continuation for a high-confidence single-book image
- inline Telegram selection buttons for low-confidence or multi-book images
- temporary D1 `telegram_image_choices` records with 24-hour expiry
- JPEG/PNG/WebP image signature validation
- configurable `MAX_TELEGRAM_IMAGE_BYTES` guardrail (4 MiB default, 6 MiB hard cap)
- image-caption preferences such as PDF/中文/英文 carried into the normal book task
- `vision: workers_ai` status in `/health`
- safe Telegram task cancellation via `/cancel`, `取消`, and `撤回`
- targeted Telegram cancellation via `/cancel <task-id>` with requester ownership checks
- authenticated HTTP cancellation endpoint at `POST /api/v1/tasks/:id/cancel`
- terminal `cancelled` task state without requiring a schema migration
- dedicated cancellation semantics documentation

### Architecture / reliability
- vision inference runs in Queue consumers instead of blocking the Telegram webhook
- image bytes are downloaded only for authorized Telegram users
- vision jobs are not automatically retried, preventing duplicate AI cost/buttons/tasks
- the vision entry layer does not persist source images in R2 or D1
- image ambiguity is resolved before creating the normal book task; source-edition ambiguity remains a separate later step
- Telegram image choice callbacks are bound to the original user and chat
- cancellation is accepted before Gmail delivery begins and rejected once the workflow has entered `delivering`, `delivery_unknown`, or `delivered`
- in-flight Queue work cannot overwrite a task already marked `cancelled`
- the workflow re-checks cancellation around search, download, R2 staging, and the final Gmail-delivery boundary
- temporary R2 objects are deleted best-effort when cancellation wins during staging
- cancelled tasks unwind without being converted into generic `failed` retries

### Documentation
- documented the one-time Meta model license/AUP prerequisite
- documented Workers AI Free daily allocation and image-size guardrails
- added image acceptance tests to Telegram/deployment guidance
- documented why Gmail/Kindle delivery cannot be truthfully "recalled" once transmission has started

## [0.3.0] - 2026-08-29

### Added
- Telegram Bot webhook entrypoint at `/telegram/webhook`
- webhook verification through Telegram `secret_token` / `X-Telegram-Bot-Api-Secret-Token`
- Telegram user allowlist via `TELEGRAM_ALLOWED_USER_IDS`
- `/whoami`, `/help`, `/send` and `/status` commands
- direct-title and lightweight natural-language book request parsing
- EPUB default preference with explicit PDF selection support
- private-chat-only Telegram operation
- D1 `telegram_task_links` mapping between core tasks and Telegram requester/chat
- inline Telegram buttons for resolving `needs_selection`
- automatic Telegram notifications for selection, no-source, staged, delivered, uncertain-delivery and failed states
- duplicate notification suppression using `last_notified_status`
- Telegram configuration status in `/health`
- dedicated Telegram deployment/setup documentation

### Security / architecture
- Telegram is implemented as an adapter around the existing task API/state machine rather than being embedded in the core book model
- task creation is denied until an explicit Telegram user allowlist is configured
- `/whoami` remains available before allowlist setup to safely bootstrap the authorized user ID
- candidate callback actions are bound to the original Telegram user and chat
- Telegram webhook traffic uses its own secret header and does not expose or reuse the normal API bearer token
- the direct Telegram -> Cloudflare path works independently of Hermes or a powered-on PC

## [0.2.2] - 2026-08-29

### Fixed
- prefer the smaller standard no-images Project Gutenberg EPUB variant so compatible public-domain books are not rejected after downloading an oversized image edition
- provide R2 with a known content length when staging streamed downloads

## [0.2.1] - 2026-08-29

### Fixed
- prevented automatic resend when Gmail delivery has started but its final outcome cannot be confirmed
- added `delivery_unknown` task state for ambiguous delivery outcomes
- persisted Gmail delivery receipts (`messageId`, `threadId`, accepted timestamp) after confirmed success
- made EPUB/PDF signature validation robust when the first bytes arrive across multiple stream chunks
- made R2 cleanup best-effort after confirmed delivery so cleanup failure cannot turn a successful Kindle send into a failed task

## [0.2.0] - 2026-08-29

### Added
- Gutendex / Project Gutenberg public-domain source adapter
- title/author search with language and EPUB/PDF filtering
- persisted ranked candidate lists in D1
- `POST /api/v1/tasks/:id/select` ambiguity-resolution endpoint
- Gmail OAuth refresh-token support
- Gmail `message/rfc822` media-upload Send-to-Kindle delivery
- streaming R2-to-Gmail MIME delivery path
- configurable cloud file-size guardrail (`MAX_CLOUD_FILE_BYTES`)
- EPUB/PDF file-signature validation before staging
- Project Gutenberg HTTPS download-host allowlist
- Gmail OAuth setup documentation
- end-to-end local and Cloudflare deployment instructions

### Changed
- activated the real source and delivery adapters in the queue consumer
- default cloud ebook threshold set to 20 MiB
- health endpoint now reports source and delivery configuration state
- README and architecture documentation updated for the first usable cloud path

### Safety / reliability
- low-confidence matches pause at `needs_selection` instead of silently sending the first result
- download streams are stopped when they exceed the configured cloud limit
- redirects outside the Project Gutenberg allowlist are rejected
- tasks found in an uncertain `delivering` state are not automatically resent, reducing duplicate Kindle documents

## [0.1.0] - 2026-08-29

### Added
- initial Cloudflare Worker project
- HTTP task creation/status API
- bearer-token API authentication
- D1 task persistence
- Cloudflare Queue asynchronous execution
- R2 staging binding
- task state machine
- deterministic candidate ranking and ambiguity guard
- source/delivery adapter contracts
- local execution via Wrangler
- Cloudflare deployment configuration
- architecture and deployment documentation

### Design decisions
- Cloudflare Free is the primary always-on target.
- Local and cloud execution share the same core codebase.
- Docker/Calibre are excluded from the Cloudflare core path.
- Heavy conversion is reserved for an optional local enhancement node.
- Search results are never blindly accepted solely because they are first in the list.
