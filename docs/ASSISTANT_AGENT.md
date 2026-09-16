# Telegram Assistant Architecture

## Core rule

```text
user natural language
-> Queue
-> model understands intent/context
-> code validates/grounds entities
-> deterministic code tool executes
-> retry-safe user reply
```

The model owns natural-language understanding. Code owns facts, validation and side effects.

Do not fix language-understanding bugs by accumulating per-title/per-author regex patches. Do not let the model invent bibliographic facts or task state.

## Why the assistant is queued

Free-form Telegram text is not processed by Workers AI inside the webhook.

The webhook validates the request, persists `telegram_assistant_jobs`, enqueues `telegram_assistant_text`, and returns quickly.

This gives three reliability properties:

1. AI/catalog latency does not hold the Telegram webhook open.
2. Telegram final-reply failures can be retried.
3. A retry cannot silently create a second logical book task because the assistant job persists its reserved `task_id` and Queue state.

## Model routes

The model may choose:

- `reply`
- `author_works`
- `book_info`
- `book`
- `status`

`author_works` and `book_info` use code-backed Open Library / Google Books queries. The model must not answer those facts from memory when a deterministic tool exists.

`status` reads actual D1 task state.

`book` may create a Kindle task only after entity grounding succeeds.

Explicit `/send <book>` remains deterministic and bypasses this free-form assistant Queue.

## Entity grounding

Model output is a proposal, not authorization.

Any model-returned title/author used by code must be present in:

- the current user message; or
- recent bounded conversation history.

The model may not silently:

- correct spelling;
- replace similar glyphs;
- translate a title;
- expand an abbreviation into a different title;
- invent an author from memory.

Example failure class:

```text
input: 纳尼亚传奇
model output: 纽里亚主事书
```

This must produce clarification/no task. The mutated title must never reach resolver/source search.

For contextual references such as `第二本`, the resolved concrete title must already appear in recent history.

If title is grounded but an optional model-supplied author is not, the author is removed rather than allowed to contaminate search.

## Conversation context

Migration `0009_telegram_conversation.sql` stores only the latest 12 user/assistant messages per private chat/user.

Purpose:

```text
第二本怎么样？
第二本发到 Kindle
这本要中文版
刚才那本发成功了吗？
```

History is bounded context, not long-term memory.

## Durable assistant job state

Migration `0013_telegram_assistant_jobs.sql` stores:

```text
update_id
chat_id
user_id
source_message_id
input_text
state
lease_token / lease_until
task_id
book_enqueued
response_text
```

### Retry rules

- Duplicate assistant Queue messages may not create a second logical task.
- Once `task_id` is reserved, retries reuse it.
- If task exists but book Queue send was not confirmed, retry may enqueue the same task again; book execution lease + delivery fence make that safe.
- Once `response_text` is persisted, reply retry does not need to rerun the model.
- A failed AI call returns a safe no-task reply; arbitrary text never degrades into “send the whole string as a book”.

## Workers AI safety

`src/workers-ai.ts` is the shared invocation boundary.

Cloudflare's AI binding is receiver-sensitive. Never invoke a detached raw `env.AI.run` function.

Text assistant default:

```text
@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

Vision path:

```text
@cf/qwen/qwen3.8-27b
```

## Code-backed catalog reliability

Author lists and book details come from `src/catalog.ts`.

Download-source results subsequently pass through the shared relevance gate before ranking.

Do not let an LLM-provided title/author or a provider's loose search result bypass these deterministic checks.

## Required regression cases

At minimum, staging must test:

1. `纳尼亚传奇` — exact entity preserved or safe clarification; mutated title is FAIL.
2. `哈利波特` — same entity-fidelity rule.
3. `倪匡` — no blind book task.
4. `倪匡有哪些值得看？` — code-backed works; no book task.
5. `第二本怎么样？` — exact historical item -> `book_info`; no task.
6. `第二本发到 Kindle` — exactly one logical book task.
7. `刚才那本发成功了吗？` — real status; no new task.
8. `把《寻秦记》发到 Kindle` — title remains exactly `寻秦记`.
9. `/send Pride and Prejudice` — deterministic path works when AI is unavailable.
10. Simulated AI failure — safe reply/no task.
11. Simulated Telegram final-reply failure — Queue retry sends reply without creating another task.
12. Duplicate assistant Queue delivery — one logical task maximum.
13. Real image test — no receiver/private-field error.

## Release gate

This document describes the stabilization branch tracked by Issue #4 / PR #5.

Do not merge PR #5 or call the project stable until the staging matrix in `docs/DEPLOYMENT.md` passes on the exact candidate HEAD.
