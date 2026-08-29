# Architecture

## 1. Product intent

Book to Kindle turns a short intent such as “send this book to my Kindle” into an asynchronous delivery task.

The core workflow remains usable in two modes:

- **Cloud mode:** always-on Cloudflare deployment, available while the user's PC is off.
- **Local mode:** the same Worker code executed locally with Wrangler, with optional access to heavyweight local tools.

The project must not require a VPS.

## 2. Hard constraints

1. The always-on workflow must fit Cloudflare Free where practical.
2. No Docker or Calibre dependency may exist in the Cloudflare core path.
3. Long-running operations must not block the HTTP/webhook request path.
4. Ebook bytes belong in object storage (R2), not D1 or Telegram.
5. Heavy conversion/repair is an optional enhancement, not a prerequisite for basic delivery.
6. A low-confidence search result must require selection rather than silently sending the first match.
7. Source, delivery and user-entry mechanisms must be adapters so they can be replaced without rewriting orchestration.
8. Bundled source adapters must target public-domain, user-owned, or otherwise authorized content.
9. Delivery retries must prefer avoiding duplicates over blind automatic resend.
10. Cloud operation must not depend on Hermes or a powered-on personal computer.

## 3. Runtime topology

```text
                     +---------------------+
Telegram ----------->| Telegram adapter    |
Hermes / HTTP ------>| HTTP/API adapter    |
Other clients ------>| future adapters     |
                     +----------+----------+
                                |
                                v
                       Cloudflare Worker
                                |
                      +---------+---------+
                      |                   |
                      v                   v
                 D1 task state          Queue
                 + entry links            |
                                           v
                                   workflow engine
                                    /           \
                                   v             v
                           Gutendex adapter    R2 staging
                           Project Gutenberg      |
                                                   v
                                            Gmail delivery
                                                   |
                                                   v
                                                Kindle
```

Telegram connects directly to Cloudflare. Hermes is an optional client of the same core workflow rather than a required relay.

## 4. Entry adapters

All entrypoints reduce user intent to the same `BookRequest`:

```json
{
  "query": "book title",
  "author": "optional author",
  "language": "optional language",
  "preferredFormat": "epub"
}
```

### HTTP/API adapter

The existing HTTP API authenticates with `API_TOKEN` and creates/reads core tasks.

### Telegram adapter

v0.3 adds `/telegram/webhook`.

The Telegram adapter:

- validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header;
- only accepts private chats;
- requires the sender to appear in `TELEGRAM_ALLOWED_USER_IDS` before task creation;
- leaves `/whoami` available before allowlist setup for bootstrap;
- parses direct titles and simple Chinese/English natural-language requests;
- creates the same core task used by the HTTP API;
- stores requester/chat linkage in a separate `telegram_task_links` table;
- maps `needs_selection` candidates to Telegram inline buttons;
- sends waiting/final task states back to the original chat.

Telegram metadata does not become part of `TaskRecord`. This keeps the core model reusable by future Web, Hermes or share-sheet adapters.

## 5. Why a queue

The HTTP/webhook request handlers only validate, persist and enqueue. This protects the request-path CPU budget and makes retries explicit.

Queue jobs can:

- call one or more source adapters;
- rank candidates;
- pause in `needs_selection`;
- download a compatible file;
- validate and stage it in R2 with a known object length;
- invoke delivery;
- retry failures that happen before delivery begins;
- notify the original Telegram requester after the resulting state is persisted.

The queue message contains only a task ID. It never contains ebook bytes or Telegram credentials.

## 6. State machine

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
                       | HTTP /select or Telegram button
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
                              |
                              | explicit human check/retry later
                              v
                           (future)

Failures before delivery begins -> failed -> Queue may retry.
```

`needs_source`, `needs_selection`, and `delivery_unknown` are intentional states rather than generic errors.

- Candidate lists are persisted in D1 so any interactive client can ask which edition to use and resume the same task.
- `delivery_unknown` means Gmail delivery had started but the final result could not be confirmed. Automatic resend is blocked because the document may already be in Gmail/Kindle.
- Successful Gmail responses produce a persisted delivery receipt when Gmail returns message metadata.

## 7. Telegram notification model

Telegram-linked tasks notify on selected waiting/final states rather than on every internal transition.

Current notification states:

- `needs_selection`
- `needs_source`
- `staged`
- `delivered`
- `delivery_unknown`
- `failed`

`telegram_task_links.last_notified_status` prevents the same state from generating repeated messages during Queue retries.

Candidate callback data contains the core task ID plus candidate index. Before applying the selection, the Worker verifies both the original Telegram user and original chat.

## 8. Candidate ranking

The current implementation uses deterministic scoring instead of an LLM:

- exact/near title match;
- author match;
- language match;
- preferred format match;
- file-size penalty for files too large for the normal cloud path.

If the best candidate has a weak score or is too close to the runner-up, the task becomes `needs_selection`.

An AI model may later be added as a secondary metadata/ranking signal, but it must not be required for the basic workflow.

## 9. Built-in source adapter

The bundled Gutendex adapter uses Project Gutenberg metadata.

Safety and scope rules:

- request `copyright=false` entries;
- return only EPUB/PDF candidates;
- prefer Project Gutenberg's standard no-images EPUB variant for the cloud path;
- restrict actual downloads to HTTPS hosts under `gutenberg.org`;
- stream downloads through a byte limit;
- validate EPUB ZIP or PDF signatures before R2 staging, including when signature bytes are split across stream chunks.

This adapter is intentionally useful for end-to-end testing without making an unauthorized-content provider part of the default project.

## 10. Delivery adapter

The first production delivery adapter is Gmail API -> Send to Kindle email.

It uses:

- OAuth refresh token stored as a secret;
- `gmail.send` scope;
- Gmail `users.messages.send` media-upload URI;
- RFC 822 multipart MIME;
- streaming from R2 into the outbound message;
- a delivery receipt containing provider, accepted timestamp, and Gmail message/thread IDs when returned.

The default cloud file threshold is **20 MiB**, capped in code below 24 MiB. This is an engineering guardrail, not an Amazon maximum.

After status becomes `delivering`, any unconfirmed outcome is treated conservatively. The task becomes `delivery_unknown` and is not automatically resent.

R2 deletion occurs only after confirmed Gmail success and is best-effort: cleanup failure cannot change a successful delivery into a failed task.

## 11. Cloudflare resource model

Design target as of 2026-08-29:

- HTTP/Telegram Worker path: lightweight validation, D1 writes and Queue enqueue.
- Queue consumer: network-heavy search/download/delivery work.
- R2: temporary ebook staging and streaming source for delivery.
- D1: core task metadata, candidate lists, delivery receipts and lightweight entry-adapter mappings.

The workflow avoids full-file buffering in JavaScript memory on the normal cloud path when the source exposes a usable content length.

## 12. Local mode

Local mode is not a fork of the backend.

```bash
npm run dev
```

Wrangler provides local Worker/D1/R2/Queue emulation, allowing the same API and state machine to run without deployment.

Telegram itself requires a public HTTPS webhook endpoint, so local Telegram testing needs a tunnel or temporary Worker deployment.

## 13. Optional local enhancement node

The optional enhancement node exists for tasks Cloudflare should not do, such as:

- converting unsupported formats;
- repairing malformed EPUBs;
- processing large files;
- running native binaries or Docker services.

Future components may include:

- Shelfmark search/download;
- Calibre conversion/repair;
- Calibre-Web Automated ingest.

These tools should communicate with the core through a narrow HTTP or queue/pull contract rather than being imported into Worker code.

Cloud mode remains useful without this node: compatible lightweight EPUB/PDF files can follow the direct path.

## 14. Adapter boundaries

### Source adapter

```ts
interface SourceAdapter {
  name: string;
  search(request: BookRequest): Promise<BookCandidate[]>;
  download(
    candidate: BookCandidate,
    options?: { maxBytes?: number }
  ): Promise<DownloadResult>;
}
```

### Delivery adapter

```ts
interface DeliveryAdapter {
  name: string;
  deliver(input: DeliveryInput): Promise<DeliveryReceipt>;
}
```

### Entry adapter principle

Entry adapters may own their own lightweight linkage/state tables, but they must ultimately create or operate on the same core `TaskRecord` and Queue workflow.

## 15. Security model

- bearer token required for HTTP task APIs;
- Telegram webhook requires its dedicated secret header;
- Telegram task creation additionally requires a user allowlist;
- secrets stored as Wrangler secrets or local `.dev.vars`;
- no credentials in D1 or Git;
- source adapters enforce explicit destination/domain allowlists;
- validate content type, file signature and size before staging;
- use opaque R2 keys rather than user-controlled paths;
- delete temporary objects after successful delivery;
- log task IDs/status, not ebook contents or secrets;
- block blind automatic resend after an uncertain Gmail delivery outcome.

## 16. Future entry points

Current clients:

- direct HTTP API;
- Telegram bot/webhook.

Planned clients:

- Hermes Skill/MCP bridge;
- browser/share-sheet bridge;
- lightweight Web UI.
