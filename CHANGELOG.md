# Changelog

All notable changes to this project will be documented in this file.

The project follows Semantic Versioning while it is practical to do so.

## [Unreleased]

### Planned
- Hermes Skill/MCP bridge
- browser/share-sheet entry point
- optional Shelfmark/CWA/Calibre enhancement node
- explicit user-controlled retry for uncertain deliveries
- additional authorized/public-domain source adapters

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
