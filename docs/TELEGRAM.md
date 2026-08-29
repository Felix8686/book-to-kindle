# Telegram entrypoint

Book to Kindle v0.4 exposes a Telegram Bot webhook directly on the Cloudflare Worker. Text requests and images both enter the same book workflow.

```text
Telegram user
    |
    +--> text request -------------------+
    |                                    |
    +--> photo / image file              |
             |                           |
             v                           |
       Queue vision job                  |
             |                           |
       Workers AI vision                 |
             |                           |
       title / author                    |
             +---------------------------+
                         |
                         v
                   D1 book task
                         |
                         v
                       Queue
                         |
                         v
                 normal book workflow
                         |
                         v
                       Kindle
```

Hermes is not required for this path. The Telegram bot remains usable while the user's PC is off.

## 1. Required Telegram secrets

Create a bot with Telegram's official `@BotFather`, then configure:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Generate `TELEGRAM_WEBHOOK_SECRET` with characters accepted by Telegram (`A-Z`, `a-z`, `0-9`, `_`, `-`). Example:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Never commit these values.

## 2. Apply migrations

Telegram text entry uses `0004_telegram_entry.sql`.
Telegram update idempotency uses `0005_telegram_update_idempotency.sql`.
Image recognition choices use `0006_telegram_image_choices.sql`.

```bash
npm run db:migrate:remote
```

For local development:

```bash
npm run db:migrate:local
```

Task cancellation uses the existing free-form `tasks.status` column and does not require an additional migration.

## 3. Workers AI binding

`wrangler.toml` contains:

```toml
[ai]
binding = "AI"
```

The current vision model is:

```text
@cf/meta/llama-3.2-11b-vision-instruct
```

Cloudflare requires accepting Meta's model license once before first use. Complete that account-level step before image testing. The model is called through the Worker AI binding; no separate VPS or GPU service is required.

Workers AI currently includes a free daily allocation. Image recognition is deliberately only invoked when an authorized user actually sends an image.

## 4. Image-size guardrail

The default configuration is:

```toml
MAX_TELEGRAM_IMAGE_BYTES = "4194304"
```

That is 4 MiB. Code also enforces a hard 6 MiB ceiling.

This keeps base64 conversion and vision inference inside a conservative Worker memory/CPU envelope. Telegram's normal photo mode usually compresses images below this limit.

Supported image inputs:

- Telegram photos;
- JPEG image documents;
- PNG image documents;
- WebP image documents.

Other files are rejected instead of being passed blindly to Workers AI.

## 5. Deploy and register webhook

```bash
npm run deploy
```

Webhook URL:

```text
https://<worker>.workers.dev/telegram/webhook
```

Register only:

- `message`
- `callback_query`

Use the same `TELEGRAM_WEBHOOK_SECRET` as Telegram's `secret_token`.

## 6. Bootstrap the user allowlist

Before the allowlist is configured, `/whoami` remains available.

Send:

```text
/whoami
```

Then configure the returned numeric ID:

```bash
npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS
```

Multiple IDs may be comma-separated. If the allowlist is empty, normal task creation and image recognition remain denied by default.

## 7. Text usage

Examples:

```text
Pride and Prejudice
```

```text
把《Pride and Prejudice》发到 Kindle
```

```text
《The Little Prince》 PDF
```

Commands:

```text
/send <书名>
/status
/cancel
/cancel <task-id>
/whoami
/help
```

Chinese cancellation shortcuts are also accepted:

```text
取消
撤回
```

## 8. Task cancellation

`/cancel` cancels the most recent Telegram-linked task that is still safely cancellable.

A specific task can be targeted with:

```text
/cancel <task-id>
```

The task ID must belong to the same allowed Telegram user.

Cancellation is accepted while the task is in:

```text
queued
searching
needs_source
needs_selection
downloading
staged
```

A successful cancellation becomes:

```text
cancelled
```

Once Gmail delivery has started, the bot refuses to claim that it can recall the document. These states therefore cannot be safely cancelled:

```text
delivering
delivery_unknown
delivered
```

If cancellation wins while Queue work is already in flight, the workflow re-checks D1 before continuing. Temporary R2 data is removed best-effort and the task is not converted into a generic failure/retry.

Before image recognition has created a normal book task, `/cancel` does not cancel the AI inference job itself. Low-confidence or multi-book image recognition already presents a `取消` button on the recognition selection prompt. Once a normal book task exists, the standard `/cancel` rules apply.

Detailed semantics: [`CANCELLATION.md`](CANCELLATION.md).

## 9. Image usage

Send a clear book cover, reading-app screenshot, bookstore photo, or book-list screenshot directly to the bot.

The bot immediately acknowledges the image, then a Queue consumer performs:

1. Telegram `getFile`;
2. bounded image download;
3. JPEG/PNG/WebP signature validation;
4. Workers AI vision inference;
5. title/author extraction;
6. conversion into the normal `BookRequest` workflow.

The webhook itself does not wait for vision inference.

### High-confidence single book

If one book is identified confidently, the bot automatically continues:

```text
识别到《Pride and Prejudice》（Jane Austen），开始查找并发送到 Kindle。
```

### Low-confidence or multi-book image

The recognition result is stored temporarily in D1 and Telegram sends inline buttons. The user selects the desired book before a book task is created.

Image-choice records expire after 24 hours and are removed after selection/cancellation.

### Image caption preferences

A caption may contain preferences such as:

```text
PDF
```

```text
英文 EPUB
```

These preferences are preserved even when recognition pauses for a selection button.

The default format remains EPUB.

## 10. Source-edition ambiguity

Image recognition ambiguity and ebook-source ambiguity are separate stages.

After a book title is known, the existing workflow may still reach `needs_selection` if multiple source editions are similarly ranked. Telegram then presents the normal source-candidate buttons and resumes the same task after selection.

## 11. Automatic notifications

Telegram-linked book tasks notify on:

- `needs_selection`;
- `needs_source`;
- `staged` when delivery is unavailable;
- `delivered`;
- `delivery_unknown`;
- `failed`.

A successful `/cancel` replies immediately with cancellation confirmation rather than relying on Queue notification delivery.

A failed Telegram notification does not turn a confirmed Kindle delivery into a failed task.

## 12. Vision retry policy

Vision jobs are intentionally **not automatically retried** by the Queue consumer.

Reason: a retry can spend the free AI allocation again and may create duplicate recognition buttons/tasks. If vision fails, the user receives a failure message and can resend the image.

Normal book tasks retain their existing retry behavior before delivery begins.

## 13. Security decisions

- webhook calls are authenticated with `X-Telegram-Bot-Api-Secret-Token`;
- task/image use requires `TELEGRAM_ALLOWED_USER_IDS`;
- only private chats are accepted;
- image candidate callbacks are bound to the original user and chat;
- source candidate callbacks are also bound to the original user and chat;
- `/cancel <task-id>` verifies the task belongs to the same Telegram user;
- Telegram file URLs are built internally and never accepted from user input;
- image bytes are size-limited and signature-checked;
- Bot/Gmail secrets are never stored in D1;
- recognition results are temporary metadata only;
- the image itself is not persisted to R2 by the vision entry layer.

## 14. Local development

Add Telegram values to `.dev.vars`:

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

Workers AI is provided by the `AI` binding. Telegram requires a public HTTPS webhook, so plain `localhost` cannot receive live Telegram updates directly. Use a secure tunnel or a temporary Cloudflare deployment for live bot testing.

## 15. Acceptance tests

After deployment, test at least these cases:

1. one clear cover -> automatic title recognition -> normal Kindle workflow;
2. screenshot with multiple books -> inline book-selection buttons;
3. blurry/non-book image -> no task created;
4. oversized image -> rejected before Workers AI;
5. unauthorized user image -> no vision inference;
6. image with caption `PDF` -> selected/recognized task preserves PDF preference;
7. create a text task and immediately send `/cancel` -> task becomes `cancelled` and no Kindle delivery occurs;
8. cancel while a task is in `needs_selection` -> later source-selection buttons cannot restart it;
9. attempt cancellation after `delivering` -> bot reports that it is too late rather than claiming success;
10. `/cancel <task-id>` for another user's task -> rejected;
11. final `delivered` state -> Telegram completion message.
