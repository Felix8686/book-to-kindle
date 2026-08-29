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
8. Entry, resolver, source and delivery mechanisms remain replaceable adapters/layers.
9. Bundled download sources target public-domain or explicitly public/free downloadable content.
10. Delivery retry behavior prioritizes avoiding duplicate Kindle documents.
11. Cloud operation must not depend on Hermes or a powered-on personal computer.
12. Language preference is a ranking signal, not a hard availability filter.

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
                  effective language
                            |
                            v
                  Work / Edition Resolver
                Open Library + Google Books
                            |
                            v
                    BookSearchContext
                            |
              +-------------+-------------+
              |             |             |
              v             v             v
          Gutendex     Google Books     Internet Archive
          Gutenberg       Free             Public
              |             |             |
              +-------------+-------------+
                            |
                    rank + deduplicate
                            |
                            v
                     selected edition
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

Telegram talks directly to Cloudflare. Hermes is an optional client rather than a required relay.

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

`language` is an explicit per-task override when present. For Telegram tasks where it is absent, the saved Telegram user preference is used. If neither exists, the system fallback is `zh`.

Telegram/image-specific metadata is not inserted into the core `TaskRecord`.

## 5. Persistent Telegram preferences

`user_settings` stores lightweight user-level book preferences:

```text
user_id
default_language
preferred_format
created_at
updated_at
```

Default behavior when no row exists:

```text
default_language = zh
preferred_format = epub
```

Effective language precedence:

```text
explicit request language
> saved Telegram user setting
> system default zh
```

This is a preference. A task may fall back to another language if no compatible preferred-language file exists.

## 6. Telegram text adapter

The `/telegram/webhook` entrypoint:

- validates `X-Telegram-Bot-Api-Secret-Token`;
- accepts private chats only;
- requires `TELEGRAM_ALLOWED_USER_IDS` for task creation/settings;
- keeps `/whoami` available for bootstrap;
- parses direct titles/simple Chinese-English requests;
- supports `/settings` and persistent `/language zh|en` controls;
- persists requester/chat linkage separately in `telegram_task_links`;
- converts source ambiguity into inline Telegram buttons;
- supports conservative `/cancel` / `取消` / `撤回` task cancellation;
- reports selected waiting/final states back to the original chat.

Telegram update replay is deduplicated through the shared `telegram_updates` table.

## 7. Telegram vision adapter

Image input does not change the core book workflow.

### Request path

The webhook validates the authorized user, checks declared size and enqueues a `telegram_image` Queue job. Vision inference never blocks the webhook.

The Queue consumer then:

1. calls Telegram `getFile`;
2. downloads the image with a strict size cap;
3. validates JPEG/PNG/WebP signatures;
4. invokes Cloudflare Workers AI;
5. extracts up to five book candidates with confidence;
6. either creates a normal `BookRequest` or asks the user to select a recognized title.

After a normal task exists, saved language preference is resolved exactly as for text input. An English cover does not force an English edition when the effective preference is `zh`.

### Vision model

Current model:

```text
@cf/meta/llama-3.2-11b-vision-instruct
```

The model uses the Worker `AI` binding. JSON Mode is requested for structured bibliographic output. The integration contains a narrow type bridge because generated Workers TypeScript declarations may lag documented runtime fields.

### Temporary image choice state

`telegram_image_choices` stores only recognition/user/chat/candidate preference metadata and expiry. Records expire after 24 hours and are deleted after selection/cancellation. Source images are not stored in D1 or R2 by this layer.

## 8. Work / Edition Resolver

v0.5 introduces a resolver layer between raw user intent and download-source search.

Its purpose is to establish a lightweight identity for the underlying work rather than treating the user-entered title as the only search string.

Normalized identity contains:

```text
canonicalTitle
authors
known title variants
languages
ISBN-10 / ISBN-13
Open Library work keys
Google Books volume IDs
```

### Open Library

Used for work identity, authors, ISBNs, work keys and edition relationships. For the strongest matching work, edition metadata is inspected so real language-specific edition titles can become search variants.

### Google Books

Used as an independent metadata resolver for titles, authors, language, ISBNs and volume identifiers.

### Failure isolation

Both resolver calls are independent. `Promise.allSettled` semantics mean one resolver failing does not abort the task. The original request always remains a fallback search identity.

### No blind translation

Cross-language discovery is based on bibliographic edition metadata. The resolver does not treat a machine translation of an English title as proof that a corresponding Chinese edition exists.

## 9. BookSearchContext

After resolution, download sources receive a normalized `BookSearchContext`:

```text
request
preferredLanguage
identity
ordered queryVariants
```

Preferred-language edition titles are placed before neutral/original/fallback titles, but fallback titles remain available.

This means:

```text
English input + saved zh
-> resolve underlying work
-> known zh edition titles first
-> original English title remains fallback
```

## 10. Download SourceAdapters

Enabled v0.5 sources:

### Gutendex / Project Gutenberg

- requires `copyright=false` search results;
- searches several resolved title variants;
- provides EPUB/PDF candidates;
- restricts downloads/redirects to `gutenberg.org` hosts;
- enforces cloud byte limits.

### Google Books Free

- searches `filter=free-ebooks`;
- only emits full/publicly downloadable records with actual EPUB/PDF download links;
- preview-only results are not candidates;
- download URLs/redirects are restricted to Google-owned content hosts.

### Internet Archive Public

- uses Open Library availability data;
- only considers records marked `ebook_access=public`;
- fetches Archive metadata;
- rejects restricted items and private files;
- emits public EPUB/PDF files only;
- restricts downloads/redirects to Archive hosts.

Additional source adapters remain optional. The cloud workflow must continue to operate if an optional source is unavailable.

## 11. Multi-source ranking and deduplication

Source response order never decides the winner.

Candidate scoring considers:

1. identifier/ISBN overlap with the resolved work;
2. title/edition match;
3. author match;
4. effective language preference;
5. requested/default format;
6. bounded source-quality weighting;
7. cloud file-size constraints.

Source quality cannot outweigh an obviously wrong work/language match.

Candidates are deduplicated across providers using ISBN + language + format when possible. Without a shared ISBN, the provider edition key remains part of the fallback key so distinct translations, publishers or revisions are not silently merged.

If the best result is not sufficiently stronger than alternatives, the task pauses at `needs_selection` instead of blindly sending.

## 12. Queue model

`TASK_QUEUE` carries two lightweight job types:

- `book` — resolution, source search, download and delivery;
- `telegram_image` — image recognition before a book task exists.

Vision jobs are deliberately acknowledged after one attempt rather than auto-retried. Book jobs retain retry behavior for failures before delivery begins.

If the Telegram webhook cannot enqueue a new text/image job, it removes any incomplete task/link created before that failure and releases the `update_id` claim so Telegram can safely retry. Claims are not released after a Queue send succeeds, preventing duplicate work when only the acknowledgement message fails.

Resolver/source calls use bounded timeouts and isolated failures to prevent one external service from monopolizing the Queue job.

## 13. Book task state machine

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

Any safely cancellable pre-delivery state -> cancelled
Failures before delivery starts -> failed -> may retry
```

`cancelled` is persisted as a terminal control-plane state. In-flight Queue work re-reads D1 around resolver/search/download/staging/delivery boundaries and cannot overwrite a user cancellation.

`delivery_unknown` blocks automatic resend because Gmail may already have accepted the document.

## 14. Delivery adapter

Gmail API -> Send to Kindle uses:

- refresh-token OAuth with `gmail.send`;
- RFC 822 MIME;
- media upload;
- R2 as the staged ebook source;
- persisted Gmail message/thread receipt after confirmed success.

The cloud ebook threshold defaults to 20 MiB and is conservatively capped below the mail limit.

## 15. Cloudflare resource model

- **Worker:** validation, routing and lightweight responses.
- **Queue:** vision/resolution/search/download/delivery network work.
- **Workers AI:** image-to-book metadata extraction.
- **D1:** task, candidate, delivery receipt, Telegram linkage/idempotency, temporary image choices and lightweight user settings.
- **R2:** temporary ebook bytes only.

Default image guardrail is 4 MiB, with a hard 6 MiB cap in code.

## 16. Optional catalog/source enhancements

### Amazon catalog

Amazon can be useful for commercial-edition metadata but is not required by v0.5. If enabled later, it should use a supported Amazon API with user-provided credentials. HTML scraping is not part of the architecture.

### Standard Ebooks / OAPEN

These remain candidates for future verified adapters. They are not hard dependencies of the current cloud path.

### Local enhancement node

Future local-only responsibilities may include Shelfmark, Calibre/CWA repair/conversion, native format conversion, and files too large/complex for the cloud path. The Cloudflare path must remain useful when this node is offline.

## 17. Security model

- HTTP task API uses bearer-token authentication.
- Telegram webhook uses its dedicated secret header.
- Telegram actions require an explicit user allowlist.
- Callback actions verify original user and chat.
- Targeted cancellation verifies Telegram task ownership.
- Telegram file URLs are generated internally from Telegram `file_id`.
- Images are size-limited and signature-checked before AI inference.
- Source adapters use explicit host/access constraints before downloadable candidates are accepted.
- Secrets stay in Wrangler secrets / `.dev.vars`, never D1 or Git.
- R2 keys remain opaque and non-user-controlled.
- Unknown Gmail delivery outcomes never trigger blind resend.

## 18. Current and future entrypoints

Current:

- HTTP API;
- Telegram text;
- Telegram images.

Planned:

- Hermes Skill/MCP bridge;
- browser/share-sheet bridge;
- lightweight Web UI.
