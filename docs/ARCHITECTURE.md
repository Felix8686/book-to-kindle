# Architecture

## 1. Product intent

Book to Kindle turns a short user intent into an asynchronous Kindle delivery task.

Supported execution modes:

- **Cloud:** always-on Cloudflare deployment, usable while the user's PC is off.
- **Local:** the same core Worker code through Wrangler, with optional access to heavyweight local tools.

The project must not require a VPS.

## 2. Hard constraints

1. The always-on path should fit Cloudflare Free where practical.
2. Docker/Calibre/native binaries must not be required by the Cloudflare core path.
3. HTTP/Telegram webhook handlers stay lightweight; expensive work goes to Queue.
4. Ebook bytes belong in R2, not D1 or Telegram.
5. Images used for recognition are bounded and transient; the vision entry layer does not persist them.
6. Heavy repair/conversion remains an optional local enhancement.
7. Ambiguous recognition/search results require user selection rather than blind send.
8. Entry, source and delivery mechanisms remain replaceable adapters.
9. Bundled sources target public-domain, user-owned or otherwise authorized content.
10. Delivery retry behavior prioritizes avoiding duplicate Kindle documents.
11. Cloud operation must not depend on Hermes or a powered-on personal computer.

## 3. Runtime topology

```text
                         Telegram
                       /          \
                  text             image
                   |                 |
                   |          Telegram adapter
                   |                 |
                   |        Queue: vision job
                   |                 |
                   |          Workers AI vision
                   |                 |
                   |      title/author or buttons
                   |                 |
                   +--------+--------+
                            |
Hermes / HTTP --------------+
Other future entries -------+
                            |
                            v
                        BookRequest
                            |
                            v
                         D1 task
                            |
                            v
                          Queue
                            |
                    search / download
                            |
                     Gutendex source
                            |
                            v
                           R2
                            |
                            v
                     Gmail delivery
                            |
                            v
                          Kindle
```

Telegram talks directly to Cloudflare. Hermes is an optional second client rather than a required relay.

## 4. Unified request contract

All entrypoints ultimately create the same request:

```json
{
  "query": "book title",
  "author": "optional author",
  "language": "optional explicit preference",
  "preferredFormat": "epub"
}
```

Telegram/image-specific metadata is not inserted into `TaskRecord`.

## 5. Telegram text adapter

The `/telegram/webhook` entrypoint:

- validates `X-Telegram-Bot-Api-Secret-Token`;
- accepts private chats only;
- requires `TELEGRAM_ALLOWED_USER_IDS` for task creation;
- keeps `/whoami` available for bootstrap;
- parses direct titles/simple Chinese-English requests;
- persists requester/chat linkage separately in `telegram_task_links`;
- converts source ambiguity into inline Telegram buttons;
- reports selected waiting/final states back to the original chat.

## 6. Telegram vision adapter

v0.4 adds image input without changing the core book workflow.

### Request path

The webhook does not perform vision inference. It only validates the authorized user, checks declared size, and enqueues a `telegram_image` Queue job.

The Queue consumer then:

1. calls Telegram `getFile`;
2. downloads the image with a strict size cap;
3. validates JPEG/PNG/WebP signatures;
4. invokes Cloudflare Workers AI;
5. extracts up to five book candidates with confidence;
6. either creates a normal `BookRequest` or asks the user to select a recognized title.

### Vision model

Current model:

```text
@cf/meta/llama-3.2-11b-vision-instruct
```

It uses the Worker `AI` binding. JSON Mode is requested for structured bibliographic output. The runtime supports that field even though the generated Workers TypeScript model declaration currently lags it, so the integration contains a narrow type bridge at the AI call boundary.

### Confidence behavior

- one sufficiently confident title -> continue automatically;
- one uncertain title -> ask for confirmation;
- multiple plausible titles -> inline selection buttons;
- no reliable title -> create no book task.

This separates **image-recognition ambiguity** from later **ebook-source ambiguity**.

### Temporary image choice state

`telegram_image_choices` stores only:

- recognition ID;
- Telegram user/chat/message linkage;
- candidate title/author/confidence metadata;
- explicit format/language preferences;
- expiry timestamp.

Records expire after 24 hours and are deleted after selection/cancellation. Source images are not stored in D1 or R2 by this layer.

## 7. Queue model

`TASK_QUEUE` carries two lightweight job types:

- `book` — normal book processing;
- `telegram_image` — image recognition before a book task exists.

Vision jobs are deliberately acknowledged after one attempt rather than auto-retried. Repeating AI inference could waste the free quota and create duplicate buttons/tasks. The bot instead tells the user to resend the image.

Book jobs retain the existing retry policy for failures before delivery begins.

## 8. Book task state machine

```text
queued
  |
  v
searching
  |-------------------+
  |                   |
  v                   v
needs_source      needs_selection
                       |
                       v
                     queued
                       |
                       v
                   downloading
                       |
                       v
                     staged
                       |
                       v
                   delivering
                    /      \
                   v        v
             delivered   delivery_unknown

Failures before delivery starts -> failed -> may retry.
```

`delivery_unknown` blocks automatic resend because Gmail may already have accepted the document.

## 9. Source adapter

The bundled Gutendex / Project Gutenberg adapter:

- requests `copyright=false` entries;
- returns EPUB/PDF candidates;
- prefers the smaller standard no-images EPUB where available;
- restricts downloads to HTTPS hosts under `gutenberg.org`;
- enforces streamed byte limits;
- validates EPUB/PDF signatures before R2 staging.

## 10. Delivery adapter

Gmail API -> Send to Kindle uses:

- refresh-token OAuth with `gmail.send`;
- RFC 822 MIME;
- media upload;
- R2 as the staged ebook source;
- persisted Gmail message/thread receipt after confirmed success.

The cloud ebook threshold defaults to 20 MiB and is conservatively capped below the mail limit.

## 11. Cloudflare resource model

- **Worker:** validation, routing, lightweight responses.
- **Queue:** vision/search/download/delivery network work.
- **Workers AI:** optional image-to-book metadata extraction.
- **D1:** task, candidates, delivery receipt, Telegram linkage, temporary image choices.
- **R2:** temporary ebook bytes only.

Default image guardrail is 4 MiB, with a hard 6 MiB cap in code.

## 12. Optional local enhancement node

Future local-only responsibilities may include:

- Shelfmark integration;
- Calibre/CWA repair/conversion;
- native format conversion;
- files too large/complex for the cloud path.

The Cloudflare path must remain useful when this node is offline.

## 13. Security model

- HTTP task API uses bearer token authentication.
- Telegram webhook uses its dedicated secret header.
- Telegram actions also require an explicit user allowlist.
- Callback actions verify original user and chat.
- Telegram file URLs are generated internally from Telegram `file_id`; users cannot supply arbitrary fetch URLs.
- Images are size-limited and signature-checked before AI inference.
- Secrets stay in Wrangler secrets / `.dev.vars`, never D1 or Git.
- R2 keys remain opaque and non-user-controlled.
- Unknown Gmail delivery outcomes never trigger blind resend.

## 14. Current and future entrypoints

Current:

- HTTP API;
- Telegram text;
- Telegram images.

Planned:

- Hermes Skill/MCP bridge;
- browser/share-sheet bridge;
- lightweight Web UI.
