# Telegram entrypoint

Book to Kindle v0.5 exposes a Telegram Bot webhook directly on the Cloudflare Worker. Text requests and images both enter the same book workflow.

Hermes is not required for this path. The Telegram bot remains usable while the user's PC is off.

## 1. Required Telegram secrets

Configure:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS
```

Never commit these values.

## 2. Apply migrations

Telegram-related migrations:

```text
0004_telegram_entry.sql
0005_telegram_update_idempotency.sql
0006_telegram_image_choices.sql
0007_user_settings.sql
```

Apply with:

```bash
npm run db:migrate:remote
```

Task cancellation uses the existing free-form `tasks.status` column and does not require a dedicated schema migration.

## 3. Default book language

A Telegram user with no saved settings automatically gets:

```text
默认书籍语言：中文优先
默认格式：EPUB
```

No explicit initialization row is required. Missing settings are interpreted as `zh` + `epub`.

Language priority:

```text
explicit language in the current request
> persistent Telegram user setting
> system default zh
```

Chinese preferred is **not** Chinese-only. If no suitable Chinese download candidate exists, the normal workflow can fall back to another language.

## 4. Settings commands

Show settings:

```text
/settings
```

Set persistent language:

```text
/language zh
/language en
```

Chinese aliases:

```text
/语言 中文
/语言 英文
```

A one-off request can override the saved default:

```text
Thinking, Fast and Slow 英文
```

If the saved default is Chinese, this task prefers English but the next task returns to Chinese preference.

## 5. Text requests

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
/settings
/language zh
/language en
/cancel
/cancel <task-id>
/whoami
/help
```

## 6. Image requests

Supported inputs:

- Telegram photos;
- JPEG image documents;
- PNG image documents;
- WebP image documents.

The webhook enqueues the vision job instead of waiting for Workers AI synchronously.

After vision identifies the book, the normal work resolver runs. This means an English cover does **not** force an English download when the user default is Chinese.

Example:

```text
saved setting: zh
image: English cover of a known translated work
vision: English title + author
resolver: discovers known edition titles
source search: Chinese edition preferred, other languages remain fallback
```

An image caption can override the current task:

```text
英文 EPUB
```

or:

```text
中文版 PDF
```

The caption override survives low-confidence/multi-book image selection.

## 7. Work resolution after Telegram input

Once a text/image request becomes a normal `BookRequest`, Queue processing performs:

```text
BookRequest
  -> effective language preference
  -> Open Library + Google Books resolver
  -> known titles / authors / ISBNs / editions
  -> multiple SourceAdapters
  -> ranking + deduplication
  -> download
  -> R2
  -> Gmail
  -> Kindle
```

See [`SOURCES.md`](SOURCES.md) for resolver/source details.

## 8. Task cancellation

Supported:

```text
/cancel
取消
撤回
/cancel <task-id>
```

Safely cancellable states:

```text
queued
searching
needs_source
needs_selection
downloading
staged
```

A successful cancellation becomes `cancelled`.

These states are too late to truthfully promise recall:

```text
delivering
delivery_unknown
delivered
```

The Queue workflow re-checks cancellation around resolver/source search, download, R2 staging and the Gmail boundary. A cancelled task cannot be restarted by an old source-selection callback; the callback also re-reads final state before enqueueing or replying.

Before image recognition has created a normal book task, the inline recognition `取消` button cancels only that recognition choice; it is separate from `/cancel` for an existing task.

Detailed semantics: [`CANCELLATION.md`](CANCELLATION.md).

## 9. Workers AI

`wrangler.toml` contains:

```toml
[ai]
binding = "AI"
```

Current vision model:

```text
@cf/meta/llama-3.2-11b-vision-instruct
```

The Cloudflare account must accept the model's Meta license/AUP before first production use.

Default image limit:

```toml
MAX_TELEGRAM_IMAGE_BYTES = "4194304"
```

Code also enforces a 6 MiB hard ceiling.

## 10. Webhook registration

Webhook URL:

```text
https://<worker>.workers.dev/telegram/webhook
```

Register `message` and `callback_query`, and use the same `TELEGRAM_WEBHOOK_SECRET` as Telegram's `secret_token`.

The webhook validates `X-Telegram-Bot-Api-Secret-Token`.

## 11. Idempotency

`0005_telegram_update_idempotency.sql` stores processed Telegram `update_id` values.

Settings commands, cancellation commands, normal text requests, image messages and callbacks all share this idempotency boundary so Telegram retries cannot create duplicate book tasks or duplicate vision work.

If Queue enqueue itself fails, incomplete task/link rows are removed and only that unconfirmed update claim is released. Telegram can then retry without leaving a permanent `queued` task. A successfully enqueued update keeps its claim even if a later acknowledgement message fails.

## 12. Security decisions

- only private chats are accepted;
- normal use requires `TELEGRAM_ALLOWED_USER_IDS`;
- `/whoami` can be used for bootstrap;
- callbacks verify the original user/chat;
- targeted cancellation verifies task ownership;
- Telegram file URLs are built internally from Telegram `file_id`;
- images are size-limited and signature-checked;
- original vision images are not persisted in R2/D1;
- Gmail/Bot credentials are never stored in D1.

## 13. Acceptance tests

After v0.5 deployment, test at least:

1. `/settings` on a user with no row -> `中文优先`, `EPUB`;
2. `/language en` -> `/settings` reports English preferred;
3. `/language zh` -> restores Chinese preferred;
4. saved `zh` + `Pride and Prejudice 英文` -> current task English preference only;
5. next request without a language -> Chinese preference restored;
6. saved `zh` + English cover image -> resolver still prefers known Chinese edition titles;
7. clear cover -> normal vision path;
8. multi-book screenshot -> image selection buttons;
9. `/cancel` during a cancellable task -> no Gmail delivery;
10. stale source-selection button after cancellation -> cannot revive the task;
11. repeated Telegram update -> no duplicate task/inference;
12. final normal task -> delivered notification and Kindle confirmation.
