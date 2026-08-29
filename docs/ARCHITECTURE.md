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
3. Long-running operations must not block the HTTP request path.
4. Ebook bytes belong in object storage (R2), not D1.
5. Heavy conversion/repair is an optional enhancement, not a prerequisite for basic delivery.
6. A low-confidence search result must require selection rather than silently sending the first match.
7. Providers and delivery mechanisms must be adapters so they can be replaced without rewriting orchestration.
8. Bundled source adapters must target public-domain, user-owned, or otherwise authorized content.
9. Delivery retries must prefer avoiding duplicates over blind automatic resend.

## 3. Runtime topology

```text
                       +-----------------------+
Telegram / Hermes ---> | HTTP/API entry Worker |
Other clients -------->|                       |
                       +-----------+-----------+
                                   |
                         write task| + enqueue
                                   v
                         +---------+---------+
                         |   D1 task state   |
                         +-------------------+
                                   ^
                                   |
                         +---------+---------+
                         | Queue consumer    |
                         | workflow engine   |
                         +----+---------+----+
                              |         |
                         search/download |
                              |         |
                              v         v
                    Gutendex adapter   R2 staging
                    Project Gutenberg     |
                                         v
                                  Gmail delivery
                                         |
                                         v
                                       Kindle
```

## 4. Why a queue

The HTTP handler only validates, persists and enqueues. This protects the request-path CPU budget and makes retries explicit.

Queue jobs can:

- call one or more source adapters;
- rank candidates;
- pause in `needs_selection`;
- download a compatible file;
- validate and stage it in R2 with a known object length;
- invoke delivery;
- retry failures that happen before delivery begins.

The queue message contains only a task ID. It never contains ebook bytes.

## 5. State machine

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
                       | POST /select
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

- Candidate lists are persisted in D1 so a chat client can ask which edition to use and resume the same task.
- `delivery_unknown` means Gmail delivery had started but the final result could not be confirmed. Automatic resend is blocked because the document may already be in Gmail/Kindle.
- Successful Gmail responses produce a persisted delivery receipt when Gmail returns message metadata.

## 6. Candidate ranking

The current implementation uses deterministic scoring instead of an LLM:

- exact/near title match;
- author match;
- language match;
- preferred format match;
- file-size penalty for files too large for the normal cloud path.

If the best candidate has a weak score or is too close to the runner-up, the task becomes `needs_selection`.

An AI model may later be added as a secondary metadata/ranking signal, but it must not be required for the basic workflow.

## 7. Built-in source adapter

v0.2 ships with a Gutendex adapter over Project Gutenberg metadata.

Safety and scope rules:

- request `copyright=false` entries;
- return only EPUB/PDF candidates;
- prefer Project Gutenberg's standard no-images EPUB variant for the cloud path;
- restrict actual downloads to HTTPS hosts under `gutenberg.org`;
- stream downloads through a byte limit;
- validate EPUB ZIP or PDF signatures before R2 staging, including when signature bytes are split across stream chunks.

This adapter is intentionally useful for end-to-end testing without making an unauthorized-content provider part of the default project.

## 8. Delivery adapter

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

## 9. Cloudflare resource model

Design target as of 2026-08-29:

- HTTP Worker path: very small CPU use; validate, persist, enqueue.
- Queue consumer: network-heavy search/download/delivery work.
- R2: temporary ebook staging and streaming source for delivery.
- D1: task metadata, candidate lists, and delivery receipts only.

The workflow avoids full-file buffering in JavaScript memory on the cloud path.

## 10. Local mode

Local mode is not a fork of the backend.

```bash
npm run dev
```

Wrangler provides local Worker/D1/R2/Queue emulation, allowing the same API and state machine to run without deployment.

## 11. Optional local enhancement node

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

## 12. Adapter boundaries

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

## 13. Security model

- bearer token required for task APIs;
- secrets stored as Wrangler secrets or local `.dev.vars`;
- no credentials in D1 or Git;
- source adapters enforce explicit destination/domain allowlists;
- validate content type, file signature and size before staging;
- use opaque R2 keys rather than user-controlled paths;
- delete temporary objects after successful delivery;
- log task IDs/status, not ebook contents or secrets;
- block blind automatic resend after an uncertain Gmail delivery outcome.

## 14. Future entry points

All entry points reduce to the same `BookRequest`:

```json
{
  "query": "book title",
  "author": "optional author",
  "language": "optional language",
  "preferredFormat": "epub"
}
```

Planned clients:

- Telegram bot/webhook;
- Hermes Skill/MCP bridge;
- browser/share-sheet bridge;
- direct HTTP API.
