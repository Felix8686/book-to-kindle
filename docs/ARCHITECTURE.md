# Architecture

## 1. Product intent

Book to Kindle turns a short intent such as “send this book to my Kindle” into an asynchronous delivery task.

The core workflow must remain usable in two modes:

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
                       Source adapters  R2 staging
                                         |
                                         v
                                  Delivery adapter
                                         |
                                         v
                                       Kindle
```

## 4. Why a queue

The HTTP handler only validates, persists and enqueues. This protects the Free-plan request CPU budget and makes retries explicit.

Queue jobs can:

- call multiple source adapters;
- rank candidates;
- pause in `needs_selection`;
- download a compatible file;
- stage it in R2;
- invoke delivery;
- retry transient failures.

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
                       | user/agent selection (future)
                       v
                   downloading
                       |
                       v
                     staged
                       |
                       v
                   delivering
                       |
             +---------+---------+
             v                   v
         delivered             failed
```

`needs_source` and `needs_selection` are intentional non-error states. They allow the workflow to ask for help only when automation is not confident enough.

## 6. Candidate ranking

The first implementation uses deterministic scoring instead of an LLM:

- exact/near title match;
- author match;
- language match;
- preferred format match;
- file-size penalty for files too large for the cloud path.

If the best candidate has a weak score or is too close to the runner-up, the task becomes `needs_selection`.

An AI model can be added later as a secondary ranking signal, but it should not be required for the basic workflow.

## 7. Cloudflare Free budget

Design target as of 2026-08-29:

- Worker request path: very small CPU budget, so request handling stays minimal.
- Queue: asynchronous work and retry boundary.
- R2: temporary file staging; objects should be deleted after successful delivery.
- D1: task metadata only.

The code intentionally sets a conservative cloud-path file threshold (currently 24 MiB). This is not a claim about Kindle's absolute limit; it is an engineering guardrail to leave room for delivery encoding and Cloudflare memory/CPU constraints.

## 8. Local mode

Local mode is not a fork of the backend.

```bash
npm run dev
```

Wrangler provides local Worker/D1/R2/Queue emulation. This lets the same code run without a Cloudflare deployment.

Future local enhancement adapters may expose:

- Shelfmark search/download;
- Calibre conversion/repair;
- Calibre-Web Automated ingest;
- other filesystem-based tools.

These adapters should communicate with the core through HTTP or queue/pull contracts rather than importing platform-specific code into the core Worker.

## 9. Local enhancement node

The optional enhancement node exists for tasks Cloudflare should not do, such as:

- converting unsupported formats;
- repairing malformed EPUBs;
- processing large files;
- using tools that require native binaries or Docker.

Cloud mode remains useful without this node: compatible EPUB/PDF files can follow the lightweight path directly.

## 10. Adapter boundaries

### Source adapter

```ts
interface SourceAdapter {
  name: string;
  search(request: BookRequest): Promise<BookCandidate[]>;
  download(candidate: BookCandidate): Promise<DownloadResult>;
}
```

Bundled source adapters should be for public-domain, user-owned, or otherwise authorized content. Other integrations remain separate deployments/configurations.

### Delivery adapter

```ts
interface DeliveryAdapter {
  name: string;
  deliver(input: DeliveryInput): Promise<void>;
}
```

The first planned production adapter is Gmail API -> Send to Kindle email.

## 11. Security model

- bearer token required for task APIs;
- secrets stored as Wrangler secrets or local `.dev.vars`;
- no credentials in D1 or Git;
- source adapters should enforce destination/domain allowlists;
- validate content type, format signature and size before staging;
- use opaque R2 keys rather than user-controlled paths;
- delete temporary objects after successful delivery;
- log task IDs/status, not ebook contents or secrets.

## 12. Future entry points

Entry points should all reduce to the same `BookRequest`:

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
