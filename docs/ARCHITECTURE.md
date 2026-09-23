# Architecture

## 1. Product intent

Book to Kindle converts Telegram / HTTP requests into a cloud-hosted ebook discovery and Send-to-Kindle workflow.

Cloudflare is the primary always-on runtime. A powered-on PC, Hermes, Docker, Calibre or a VPS is not required for the normal path.

## 2. Non-negotiable boundaries

1. Natural-language understanding belongs to the model.
2. Deterministic facts and side effects belong to code.
3. Webhooks stay lightweight; expensive AI/network work goes to Queue.
4. Ebook bytes live temporarily in R2, never in D1 or Telegram.
5. Ambiguous source results pause for user selection instead of blind delivery.
6. Duplicate Queue delivery must not cause duplicate Gmail / Kindle delivery.
7. An uncertain Gmail result must never trigger blind automatic resend.
8. Model-generated title/author values are untrusted until grounded in user-visible evidence.
9. Repository migrations must be able to reproduce every production D1 dependency.
10. `main` is not considered stable merely because unit tests pass; real staging acceptance is mandatory.

## 3. Semantic vs deterministic responsibility

```text
Natural-language understanding -> Workers AI
Grounding / validation / facts / side effects -> deterministic code
```

The model may decide:

- normal reply / clarification;
- author works query;
- book information query;
- Kindle book task;
- task status query.

The model may not invent:

- author work lists;
- editions / ISBNs / publication metadata;
- download availability;
- task state;
- delivery state.

Those values come from code-backed data sources and D1.

### Entity grounding

A model classification is not enough to authorize an entity.

Before `title` or `author` can drive a catalog query or book task, the normalized entity must occur in either:

- the current user message; or
- the bounded recent conversation history.

Therefore a model output such as:

```text
user: 纳尼亚传奇
model title: 纽里亚主事书
```

is rejected before search/task creation. The safe result is clarification, not a wrong downstream request.

If a title is grounded but an optional author is not, the ungrounded author is discarded rather than allowed to contaminate search.

## 4. Runtime topology

```text
Telegram
  |
  +-- deterministic commands (/send /status /settings /cancel ...)
  |
  +-- free-form text
  |     -> webhook validation + update claim
  |     -> D1 telegram_assistant_jobs
  |     -> Queue: telegram_assistant_text
  |     -> Workers AI assistant
  |     -> entity grounding
  |     -> code-backed reply/status/catalog OR BookRequest
  |
  +-- image
        -> Queue: telegram_image
        -> Workers AI Vision
        -> recognized title / user selection
        -> BookRequest

HTTP POST /api/v1/tasks ----------------------+ 
                                             |
BookRequest ----------------------------------+
                                             v
                                            D1 task
                                             |
                                             v
                                      Queue: book
                                             |
                                      execution lease
                                             |
                                             v
                                  Work/edition resolver
                              Open Library + Google Books
                                             |
                                             v
                               SourceAdapter searches
                        ZLibrary / Gutendex / Google / IA
                                             |
                                      relevance gate
                                             |
                                  rank + deduplicate
                                             |
                                   select / confirm
                                             |
                                           R2
                                             |
                                     delivery fence
                                             |
                                      Gmail API
                                             |
                                          Kindle
```

## 5. Telegram free-form text

Free-form Telegram messages no longer run Workers AI inside the webhook.

The webhook:

1. verifies Telegram secret;
2. verifies private chat + allowed user;
3. claims `telegram_updates.update_id`;
4. creates `telegram_assistant_jobs` state;
5. enqueues `telegram_assistant_text`;
6. returns to Telegram quickly.

The Queue consumer owns AI, catalog calls and the final reply.

`telegram_assistant_jobs` persists enough information to make retry safe:

- original `update_id` / source message;
- input text;
- processing lease;
- reserved book `task_id` if one is created;
- whether the book Queue message was confirmed enqueued;
- final response text.

If Telegram `sendMessage` fails, Queue can retry the reply without creating a second logical book task.

If book Queue send succeeded but the worker crashed before recording that success, the assistant job may enqueue the same `task_id` again. This is safe because the book Queue has its own execution lease and the Gmail path has a permanent delivery fence.

### Conversation context

`telegram_conversation_messages` retains only a bounded recent history (12 messages per user/chat).

It exists for contextual references such as:

```text
第二本怎么样？
第二本发到 Kindle
刚才那本发成功了吗？
```

It is not a long-term user profile store.

## 6. Workers AI

### Assistant text

Default:

```text
@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

Override:

```text
ASSISTANT_MODEL
```

Text output is structured JSON and then normalized + grounded before deterministic execution.

### Vision

Actual Vision model:

```text
@cf/qwen/qwen3.8-27b
```

`src/workers-ai.ts` is the only compatibility boundary for receiver-sensitive Workers AI calls. It also adapts the legacy image request shape into Qwen multimodal messages.

Do not extract and invoke a bare `env.AI.run` without preserving its receiver.

## 7. Unified BookRequest

All delivery entrypoints converge on:

```ts
interface BookRequest {
  query: string;
  author?: string;
  language?: string;
  preferredFormat?: "epub" | "pdf";
}
```

Language precedence for Telegram tasks:

```text
explicit request
> saved user setting
> zh default
```

Language is a preference, not a hard availability filter.

## 8. Work / edition resolution

Before source search, the worker builds `BookSearchContext` using:

- Open Library;
- Google Books.

Identity may include:

- canonical title;
- verified title variants;
- authors;
- ISBN-10 / ISBN-13;
- Open Library work keys;
- Google volume IDs.

Unverified top search results must never inject unrelated ISBN/title/author metadata into the canonical identity.

Resolver failures are isolated; the original request remains a fallback identity.

## 9. Sources and relevance

Enabled source adapters:

- `zlibrary`
- `gutendex`
- `google-books-free`
- `internet-archive-public`

Every adapter is wrapped by the same deterministic relevance gate before candidates reach ranking.

A candidate is accepted when deterministic evidence supports it, primarily:

- matching ISBN/identifier; or
- compatible title variant;
- plus compatible requested author when an author was explicitly supplied.

This prevents a provider's loose search results from filling `needs_selection` with unrelated books.

## 10. Candidate ranking

After the relevance gate, ranking considers:

1. identifier overlap;
2. title / edition match;
3. author match;
4. preferred language;
5. requested/default format;
6. bounded source quality;
7. cloud size constraints.

Source response order never decides the winner.

If the winner is not sufficiently stronger than alternatives, the task enters `needs_selection`.

## 11. Book Queue execution lease

Cloudflare Queues may replay a message or deliver duplicate copies.

`task_execution_leases` serializes execution per `task_id`:

- the first consumer obtains a bounded lease;
- concurrent copies are acknowledged without running the workflow;
- a hard-crashed lease becomes recoverable after expiry;
- normal processing releases the lease in `finally`.

The lease reduces duplicated resolver/download work. It is not the final side-effect guarantee; Gmail's delivery fence is.

## 12. Delivery fence and crash recovery

Before the irreversible Gmail send, `GmailDelivery` creates one durable `delivery_fences` row for the task.

States:

```text
started
accepted
unknown
```

Only one `task_id` can own a fence.

### Duplicate execution

If a replay reaches Gmail delivery again:

- `accepted` -> return the persisted receipt, do not resend;
- `started` / `unknown` -> block automatic resend.

### Crash after Gmail accepted

There is a critical crash window:

```text
Gmail accepts message
-> worker crashes
-> TaskRecord still says delivering
```

`DeliveryAdapter.recover()` reads the permanent fence. If it contains `accepted`, workflow repairs the task to `delivered` and cleans R2 rather than setting `delivery_unknown` or resending.

If acceptance cannot be recovered, task becomes `delivery_unknown`.

## 13. HTTP idempotency

`POST /api/v1/tasks` accepts optional:

```http
Idempotency-Key: <1..128 chars>
```

`api_idempotency` maps one key to one task.

If task creation succeeds but Queue enqueue fails, the task and reservation are rolled back and the endpoint returns `503`. A client may safely retry.

Candidate selection similarly restores `needs_selection` if its Queue enqueue fails.

## 14. Telegram control failure semantics

Settings/help/status/cancellation paths use `telegram_updates` replay claims.

For idempotent control operations, if the Telegram reply fails, the claim is released and the webhook returns a temporary failure so Telegram can retry the missing response.

Free-form assistant text has stronger durable job state and therefore does not need to release the Telegram claim after Queue acceptance.

Image Queue work remains intentionally conservative: once image work is confirmed enqueued, the update claim is retained so a missing acknowledgement cannot duplicate vision work.

## 15. Task state machine

```text
queued
  -> searching
     -> needs_source
     -> needs_selection -> queued
     -> downloading
        -> staged
           -> delivering
              -> delivered
              -> delivery_unknown

pre-delivery cancellable states -> cancelled
pre-delivery failures -> failed
```

`delivery_unknown` is terminal for automatic delivery.

## 16. Storage responsibilities

### D1

- tasks/candidates/receipts
- Telegram task links/update claims
- user settings
- image choices
- conversation history
- assistant Queue jobs
- delivery fences
- API idempotency
- task execution leases
- usage counters

### R2

Only temporary ebook bytes.

### Queue

Current kinds:

```text
book
telegram_image
telegram_assistant_text
```

### Worker

Validation, routing, lightweight API responses, Queue consumer.

## 17. Security model

- HTTP task API: bearer token.
- Telegram webhook: Telegram secret-token header.
- Telegram actions: explicit user allowlist.
- Callback actions: original user/chat verification.
- Source downloads: explicit host/access restrictions.
- ZLibrary account credentials are restricted to trusted session domains and are not sent to third-party signed CDN hosts.
- Secrets stay in Cloudflare secrets / local dev vars, never Git or D1.
- Images are bounded and signature-validated and are not persisted by the recognition layer.
- R2 keys are opaque and generated by the service.

## 18. Migration contract

The current schema contract is migrations `0001` through `0013` in repository order.

A deployment is invalid if production contains application-required schema not reproducible from this sequence.

## 19. Release gate

Unit tests and typecheck are necessary, not sufficient.

Before merge/release, the exact branch build must be exercised in isolated Cloudflare staging with real Telegram, Workers AI, real sources and a controlled Gmail -> Kindle path, including duplicate/retry/failure scenarios.
