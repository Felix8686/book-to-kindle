# Deployment

This project supports local and Cloudflare execution from the same codebase.

## A. Local mode

Use local mode for development, testing, or running the core workflow on a machine/NAS without deploying to Cloudflare.

### Requirements

- Node.js 20+
- npm

### 1. Install

```bash
git clone https://github.com/Felix8686/book-to-kindle.git
cd book-to-kindle
npm install
```

### 2. Configure local secrets

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

See [`GMAIL_OAUTH.md`](GMAIL_OAUTH.md) for Gmail OAuth and [`TELEGRAM.md`](TELEGRAM.md) for Telegram setup.

### 3. Apply D1 migrations

```bash
npm run db:migrate:local
```

This applies the task schema, candidate persistence, delivery receipts, and Telegram task mapping.

### 4. Start

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:8787/health
```

### 5. Create a public-domain test task

```bash
curl -X POST http://localhost:8787/api/v1/tasks \
  -H "Authorization: Bearer replace-with-a-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"query":"Pride and Prejudice","author":"Jane Austen","language":"en","preferredFormat":"epub"}'
```

Poll the returned ID:

```bash
curl http://localhost:8787/api/v1/tasks/<TASK_ID> \
  -H "Authorization: Bearer replace-with-a-long-random-secret"
```

If the task becomes `needs_selection`, choose one returned candidate:

```bash
curl -X POST http://localhost:8787/api/v1/tasks/<TASK_ID>/select \
  -H "Authorization: Bearer replace-with-a-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"candidateId":"gutenberg:1342:epub"}'
```

A successful task reaches `delivered` and may include a Gmail `deliveryReceipt` with message/thread IDs.

If a task reaches `delivery_unknown`, do not blindly resend it. Check Gmail Sent and the Kindle library first.

### Local Telegram note

Telegram requires a public HTTPS webhook URL. A plain local Wrangler URL such as `http://localhost:8787` cannot be registered directly with Telegram.

Use either:

- a secure HTTPS tunnel for local Telegram testing; or
- the normal deployed Cloudflare Worker for Telegram while testing the rest locally.

---

## B. Cloudflare mode

Cloudflare is the always-on deployment target. A VPS is not required.

### 1. Authenticate Wrangler

```bash
npx wrangler login
```

### 2. Create D1

```bash
npx wrangler d1 create book-to-kindle
```

Copy the returned database ID into `wrangler.toml`.

### 3. Create R2

```bash
npx wrangler r2 bucket create book-to-kindle-files
```

### 4. Create queues

```bash
npx wrangler queues create book-to-kindle-tasks
npx wrangler queues create book-to-kindle-dlq
```

### 5. Configure core/Gmail secrets

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put KINDLE_EMAIL
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
npx wrangler secret put GMAIL_FROM_EMAIL
```

Never place credentials in `wrangler.toml` or commit them to Git.

### 6. Configure Telegram bootstrap secrets

Create a Telegram bot through `@BotFather`, then configure:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Do not configure `TELEGRAM_ALLOWED_USER_IDS` until you have used `/whoami`, unless you already know your numeric Telegram user ID.

See [`TELEGRAM.md`](TELEGRAM.md) for the exact setup flow.

### 7. Apply all migrations

```bash
npm run db:migrate:remote
```

Current migrations:

```text
0001_init.sql
0002_candidates.sql
0003_delivery_receipt.sql
0004_telegram_entry.sql
```

### 8. Deploy

```bash
npm run deploy
```

### 9. Verify health

```bash
curl https://<your-worker>.workers.dev/health
```

A configured deployment should report Gmail delivery and Telegram as configured.

### 10. Register the Telegram webhook

Register:

```text
https://<your-worker>.workers.dev/telegram/webhook
```

Use the same value stored as `TELEGRAM_WEBHOOK_SECRET` as Telegram's `secret_token` and restrict updates to:

```text
message
callback_query
```

Full commands: [`TELEGRAM.md`](TELEGRAM.md).

### 11. Discover and authorize the Telegram user

Send the bot:

```text
/whoami
```

Then save the returned numeric user ID:

```bash
npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS
```

For multiple allowed users, store a comma-separated list.

If this secret is absent or empty, Telegram task creation remains denied by default.

### 12. Run an end-to-end Telegram test

Send the bot:

```text
把《Pride and Prejudice》发到 Kindle
```

Expected flow:

```text
Telegram acknowledgement
-> Queue processing
-> optional inline candidate selection
-> Gmail delivery
-> Telegram "已发送到 Kindle" notification
```

The user should not need the HTTP API for normal operation.

---

## C. Cloud-path resource guardrails

The default Worker configuration uses:

```toml
MAX_CLOUD_FILE_BYTES = "20971520"
```

This is 20 MiB. It intentionally leaves room below Gmail's normal personal-account attachment ceiling.

The source adapter also:

- limits streamed downloads to this size;
- prefers Project Gutenberg's standard no-images EPUB variant when available;
- restricts download hosts to `gutenberg.org`;
- validates EPUB/PDF signatures before R2 staging, even if the signature arrives across multiple stream chunks.

R2 staging supplies the known content length through `FixedLengthStream` when the source provides one; otherwise it uses a bounded buffer that remains within the same cloud-size guardrail.

Telegram messages only create lightweight D1 records and Queue messages; book bytes never pass through Telegram or D1.

If a future source supplies a file that needs native repair/conversion or is too large for this path, the workflow should delegate it to the optional local enhancement node instead of forcing Cloudflare to process it.

---

## D. Optional local enhancement node

The enhancement node remains deliberately separate from the Worker runtime.

Expected responsibilities:

- Shelfmark integration;
- Calibre/CWA repair and conversion;
- processing files too large or expensive for the Cloudflare path;
- handling formats that need native conversion before Send to Kindle.

The core workflow must continue to function while this node is offline.

Desired behavior:

- PC/NAS online: difficult tasks can be delegated locally.
- PC/NAS offline: Cloudflare still handles compatible lightweight EPUB/PDF files independently.

---

## E. Production checklist

Before treating the deployment as complete:

- [ ] Replace the placeholder D1 database ID.
- [ ] Configure a strong `API_TOKEN`.
- [ ] Apply all D1 migrations (`0001` through `0004`).
- [ ] Configure Gmail OAuth secrets.
- [ ] Confirm the Gmail sender is permitted by Amazon Send to Kindle settings.
- [ ] Verify the correct Kindle Send-to-Kindle email address.
- [ ] Run at least one successful public-domain EPUB delivery.
- [ ] Verify `delivery_unknown` never causes an automatic resend.
- [ ] Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`.
- [ ] Register `/telegram/webhook` with Telegram using `secret_token`.
- [ ] Verify `/whoami` works before Telegram allowlist setup.
- [ ] Configure `TELEGRAM_ALLOWED_USER_IDS`.
- [ ] Verify unauthorized Telegram users cannot create tasks.
- [ ] Verify group chats are rejected.
- [ ] Verify `needs_selection` produces inline buttons and resumes the same task after selection.
- [ ] Verify Telegram receives the final `delivered` notification.
- [ ] Configure an R2 lifecycle rule as a second safety net for stale temporary objects.
- [ ] Review queue/dead-letter failures before adding explicit retry controls for uncertain delivery.
