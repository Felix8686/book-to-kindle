# Deployment

This project supports local and Cloudflare execution from the same codebase. Cloudflare is the always-on target; no VPS is required.

## A. Local mode

Requirements:

- Node.js 20+
- npm

```bash
git clone https://github.com/Felix8686/book-to-kindle.git
cd book-to-kindle
npm install
```

Create `.dev.vars`:

```dotenv
API_TOKEN=replace-with-a-long-random-secret
KINDLE_EMAIL=your-kindle-address@kindle.com
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_FROM_EMAIL=your-gmail-address@gmail.com
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

Apply migrations and start:

```bash
npm run db:migrate:local
npm run dev
```

Telegram requires a public HTTPS webhook, so live Telegram testing needs a tunnel or deployed Worker. The core HTTP API remains locally testable.

---

## B. Cloudflare resources

### 1. Authenticate Wrangler

```bash
npx wrangler login
```

### 2. D1

Use the existing `book-to-kindle` D1 database configured in `wrangler.toml`. Do not recreate it during an upgrade.

### 3. R2

Use the existing `book-to-kindle-files` bucket.

### 4. Queues

Use the existing task queue and DLQ configured in `wrangler.toml`.

### 5. Workers AI

The repository contains:

```toml
[ai]
binding = "AI"
```

The Telegram image path currently uses:

```text
@cf/meta/llama-3.2-11b-vision-instruct
```

Before the first real image test, accept Meta's license/AUP for this model once on the same Cloudflare account. This is an account/model prerequisite, not an application secret.

No external vision server, GPU, VPS, or paid vision API key is required for the normal path.

---

## C. Configure secrets

Core/Gmail:

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put KINDLE_EMAIL
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
npx wrangler secret put GMAIL_FROM_EMAIL
```

Telegram:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS
```

Existing deployments should reuse existing secrets. Do not rotate/re-enter them merely because the application version changed.

Never place credentials in `wrangler.toml`, README, logs, or Git.

---

## D. Apply migrations

```bash
npm run db:migrate:remote
```

Current migration sequence:

```text
0001_init.sql
0002_candidates.sql
0003_delivery_receipt.sql
0004_telegram_entry.sql
0005_telegram_update_idempotency.sql
0006_telegram_image_choices.sql
0007_user_settings.sql
0008_usage_counters.sql
```

Important roles:

- `0005` prevents Telegram update replay from creating duplicate work;
- `0006` stores temporary image-recognition choices only;
- `0007` stores persistent user book settings (`zh` + EPUB defaults);
- `0008` stores monthly application usage counters for Free Tier Guard.

The original image itself is not persisted in D1. Task cancellation uses the existing free-form `tasks.status` value and needs no additional migration.

---

## E. Deploy

```bash
npm install
npm run typecheck
npm test
npm run deploy
```

Health check:

```bash
curl https://<your-worker>.workers.dev/health
```

A deployment should report the active resolver/source inventory, for example:

```json
{
  "resolvers": ["openlibrary", "google-books"],
  "sources": ["gutendex", "google-books-free", "internet-archive-public", "zlibrary"],
  "zlibrary": "configured",
  "defaultLanguage": "zh",
  "vision": "workers_ai",
  "freeTierGuard": "enabled"
}
```

Also verify Gmail delivery and Telegram are configured.

---

## F. Telegram webhook

Webhook URL:

```text
https://<your-worker>.workers.dev/telegram/webhook
```

Use the existing `TELEGRAM_WEBHOOK_SECRET` as Telegram's `secret_token` and allow:

```text
message
callback_query
```

See [`TELEGRAM.md`](TELEGRAM.md) for settings, image input, cancellation and acceptance tests.

---

## G. v0.5 resolver/source behavior

Queue book jobs now perform:

```text
BookRequest
  -> effective language preference
  -> Open Library + Google Books metadata resolution
  -> resolved title/ISBN/author identity
  -> parallel download-source search
  -> ranking + deduplication
  -> download
  -> R2
  -> Gmail
```

Enabled download sources:

```text
gutendex
google-books-free
internet-archive-public
```

Metadata/source network failures are isolated with `Promise.allSettled`; one provider failing must not terminate the entire search.

The default language is `zh`, but this is a ranking preference rather than a hard filter. If no compatible Chinese candidate exists, another-language candidate may still win.

See [`SOURCES.md`](SOURCES.md) for the detailed source policy.

---

## H. Cloud resource guardrails

Book delivery default:

```toml
MAX_CLOUD_FILE_BYTES = "20971520"
```

Telegram vision default:

```toml
MAX_TELEGRAM_IMAGE_BYTES = "4194304"
```

The image path also has a hard 6 MiB code cap.

Design rules:

- webhook handlers stay light;
- image inference runs from Queue, not synchronously in the webhook;
- resolver and multi-source search run from the book Queue path;
- external metadata/source requests use bounded timeouts and isolated failures;
- Google Books download candidates must be full/free with an actual EPUB/PDF link;
- Internet Archive candidates must be explicitly public and non-restricted/non-private;
- ebook bytes stay in R2, never D1;
- D1 contains lightweight task/Telegram/settings metadata only;
- no Docker/Calibre/native binaries are required in the Cloudflare core path.

---

## I. Production acceptance checklist

Before considering v0.5.1 complete in a real deployment:

- [ ] Migrations `0001` through `0007` are applied.
- [ ] `npm run typecheck` passes.
- [ ] GitHub Actions CI is green.
- [ ] `/health` reports Open Library + Google Books resolvers.
- [ ] `/health` reports Gutendex, Google Books Free and Internet Archive Public sources.
- [ ] `/settings` on a user with no settings row reports `中文优先` and `EPUB`.
- [ ] `/language en` persists English preference.
- [ ] `/language zh` restores Chinese preference.
- [ ] An explicit `英文`/`中文` in one request overrides only that task.
- [ ] Saved `zh` + English title attempts known Chinese edition titles first and can fall back if unavailable.
- [ ] Saved `zh` + English book-cover image still uses the saved language after vision recognition.
- [ ] One resolver failure does not stop the other resolver/source searches.
- [ ] One download source failure does not stop remaining sources.
- [ ] Duplicate editions from multiple sources are deduplicated before selection.
- [ ] Existing text -> Kindle path still passes.
- [ ] Existing image -> Kindle path still passes.
- [ ] Telegram update idempotency prevents duplicate task/image work.
- [ ] `/cancel`, `取消`, `撤回` still stop cancellable tasks and cannot revive through stale buttons.
- [ ] Cancellation after `delivering` does not falsely claim recall success.
- [ ] Gmail sender remains approved by Amazon Send to Kindle.
- [ ] Final Kindle delivery still produces Telegram `delivered` notification.
- [ ] `delivery_unknown` never triggers blind automatic resend.
