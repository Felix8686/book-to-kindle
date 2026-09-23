# Deployment and acceptance

Book to Kindle is Cloudflare-first. The normal always-on path uses Workers, Queues, Workers AI, D1 and R2; no VPS is required.

## 1. Release rule

Do not deploy an unverified stabilization branch directly over production.

Required order:

```text
feature/stabilization branch
-> GitHub CI
-> isolated Cloudflare staging
-> real Telegram / Workers AI / source / delivery regression
-> final review
-> merge main
-> production deployment
-> production smoke test
```

`npm test` passing by itself is not a release decision.

## 2. Local prerequisites

```text
Node.js 20+
npm
Wrangler authenticated to the target Cloudflare account
```

Basic validation:

```bash
npm install
npm run typecheck
npm test
```

## 3. Cloudflare resources

Production and staging must use separate resources wherever side effects or state could collide.

Required resource types:

- Worker
- D1 database
- R2 bucket
- Queue + optional DLQ
- Workers AI binding `AI`

Staging must not silently reuse production D1/R2/Queue when running destructive/failure-injection tests.

## 4. D1 migrations

Apply in order:

```text
0001_init.sql
0002_candidates.sql
0003_delivery_receipt.sql
0004_telegram_entry.sql
0005_telegram_update_idempotency.sql
0006_telegram_image_choices.sql
0007_user_settings.sql
0008_usage_counters.sql
0009_telegram_conversation.sql
0010_delivery_fence.sql
0011_api_idempotency.sql
0012_task_execution_lease.sql
0013_telegram_assistant_jobs.sql
```

Roles of the stabilization migrations:

- `0009`: bounded Telegram conversation context.
- `0010`: permanent Gmail delivery side-effect fence.
- `0011`: HTTP `Idempotency-Key` reservations.
- `0012`: replay/concurrency lease for `book` Queue jobs.
- `0013`: durable/retry-safe free-form Telegram assistant jobs.

A deployment must fail acceptance if production depends on a table/index that is not reproducible from repository migrations.

## 5. Secrets and configuration

Core:

```text
API_TOKEN
KINDLE_EMAIL
```

Gmail:

```text
GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET
GMAIL_REFRESH_TOKEN
GMAIL_FROM_EMAIL
```

Telegram:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
TELEGRAM_ALLOWED_USER_IDS
```

ZLibrary, when enabled:

```text
ZLIBRARY_REMIX_USERID
ZLIBRARY_REMIX_USERKEY
```

or:

```text
ZLIBRARY_EMAIL
ZLIBRARY_PASSWORD
```

Optional:

```text
ZLIBRARY_DOMAIN
ASSISTANT_MODEL
MAX_CLOUD_FILE_BYTES
MAX_TELEGRAM_IMAGE_BYTES
FREE_TIER_GUARD_ENABLED
```

Secrets must stay in Cloudflare secrets / local `.dev.vars`; never commit them.

## 6. Workers AI models

Text assistant default:

```text
@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

Override with `ASSISTANT_MODEL` only after the replacement model has passed the same entity-grounding and routing matrix.

Vision path:

```text
@cf/qwen/qwen3.8-27b
```

The application uses `src/workers-ai.ts` to preserve the receiver-sensitive `AI.run` binding and to adapt the image request to Qwen multimodal input.

Do not reintroduce an extracted bare `env.AI.run` call.

## 7. Health check

After staging deployment:

```bash
curl https://<staging-worker>/health
```

Expected categories include:

```json
{
  "ok": true,
  "assistant": "queued_workers_ai",
  "vision": "workers_ai",
  "telegram": "configured",
  "delivery": "gmail",
  "zlibrary": "configured"
}
```

Exact source availability may depend on configured credentials, but the reported state must match the intended environment.

## 8. Staging acceptance matrix

All items below are required before production authorization.

### A. Entity fidelity / routing

Use real Telegram messages and the actual configured text model.

Required cases include:

```text
纳尼亚传奇
哈利波特
把《天龙八部》发到 Kindle
倪匡
倪匡有哪些值得看？
第二本怎么样？
第二本发到 Kindle
刚才那本发成功了吗？
```

Acceptance:

- A title may not be silently rewritten into another title.
- If the model outputs an ungrounded title/author, no book task is created.
- Author-only text must not be blindly treated as a book title.
- Contextual references must resolve only to entities actually present in bounded history.
- Status questions create no new book task.
- Explicit `/send` remains usable even if the assistant model is unavailable.

For the original regression:

```text
input: 纳尼亚传奇
```

The only acceptable target outcomes are:

1. exact title `纳尼亚传奇` enters the book flow; or
2. the assistant asks for clarification without creating a task.

Any mutated title is FAIL.

### B. Assistant Queue reliability

Inject / simulate:

- Workers AI timeout/failure;
- catalog timeout;
- Telegram `sendMessage` failure;
- duplicate `telegram_assistant_text` Queue delivery;
- crash/retry after a book `task_id` is reserved;
- crash/retry after the book Queue message is sent.

Acceptance:

- no duplicate logical book task;
- missing Telegram final reply can be retried;
- AI failure cannot turn arbitrary text into a book task;
- assistant job leaves a diagnosable D1 state.

### C. Book Queue concurrency

Deliver the same `book` Queue message concurrently/repeatedly.

Acceptance:

- only one active execution lease owns the workflow at a time;
- duplicate Queue copies do not produce duplicate Gmail sends;
- expired lease can be recovered after a simulated hard crash.

### D. Resolver/source relevance

Test common, translated, ambiguous and same-title/different-author cases.

Acceptance:

- unrelated source records are filtered before ranking;
- ISBN overlap can establish strong identity;
- explicit author mismatch prevents title-only false positives;
- provider failure does not stop remaining sources.

### E. Download/R2 failures

Test:

- invalid EPUB/PDF signature;
- oversized file;
- source download timeout/failure;
- R2 PUT failure;
- staged object missing.

Acceptance:

- no Gmail send happens with invalid/incomplete data;
- task reaches a truthful terminal/retry state;
- cancellation cannot be overwritten by stale Queue work.

### F. Gmail delivery fence

Required controlled tests:

1. Duplicate delivery call after confirmed Gmail acceptance.
2. Network loss after Gmail request begins.
3. Worker crash after Gmail returns success but before `TaskRecord` becomes `delivered`.
4. Replay while fence is `unknown`.

Acceptance:

- confirmed accepted send is not sent twice;
- accepted receipt is recovered after crash;
- uncertain send becomes `delivery_unknown` and is not automatically retried;
- R2 object is cleaned after recovered confirmed delivery.

### G. Telegram image

Use at least one clear known cover, including the previously validated `1984 / George Orwell` test if available.

Acceptance:

- actual model is Qwen Vision path;
- no receiver/private-field error;
- title/author are recognized or user is offered a normal candidate choice;
- no duplicate task from one image update.

### H. Real source -> Gmail -> Kindle

At least one controlled end-to-end task must pass:

```text
Telegram
-> book task
-> resolver/source
-> candidate selection if needed
-> download
-> R2
-> Gmail
-> Kindle
-> Telegram delivered notification
```

Do not intentionally repeat-send the same document merely to test idempotency; use mocked/controlled Gmail for destructive failure injection and one real final delivery for last-mile acceptance.

## 9. HTTP API acceptance

Create task with an idempotency key:

```http
POST /api/v1/tasks
Authorization: Bearer <API_TOKEN>
Idempotency-Key: acceptance-001
Content-Type: application/json

{
  "query": "Pride and Prejudice",
  "language": "en",
  "preferredFormat": "epub"
}
```

Retry the exact request with the same key.

Acceptance:

- same logical task id is returned;
- no second book task is created.

Then inject Queue enqueue failure.

Acceptance:

- endpoint returns `503`;
- failed task row and key reservation are rolled back;
- retry is safe.

## 10. Production promotion

Only after staging is fully green:

1. record staging HEAD and evidence;
2. review PR diff and migrations;
3. merge only with explicit authorization;
4. apply new production migrations;
5. deploy exact merged `main` HEAD;
6. run a reduced production smoke test;
7. record Worker Version/Deployment IDs and final HEAD.

Do not call the project `FINAL` or `complete` until this sequence is finished.

## 11. Rollback

Before production promotion record the current production Worker Version ID and current `main` HEAD.

If a new deployment fails before an irreversible Gmail side effect, roll back Worker code normally.

Never "fix" an uncertain Gmail delivery by blindly replaying it. Inspect `delivery_fences` / task state first.
