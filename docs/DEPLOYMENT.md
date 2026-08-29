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

```bash
npx wrangler d1 create book-to-kindle
```

Put the returned database ID in `wrangler.toml`.

### 3. R2

```bash
npx wrangler r2 bucket create book-to-kindle-files
```

### 4. Queues

```bash
npx wrangler queues create book-to-kindle-tasks
npx wrangler queues create book-to-kindle-dlq
```

### 5. Workers AI

The repository already contains:

```toml
[ai]
binding = "AI"
```

The Telegram image path currently uses:

```text
@cf/meta/llama-3.2-11b-vision-instruct
```

Before the first real image test, accept Meta's license/AUP for this model once on the same Cloudflare account. This is an account/model prerequisite, not an application secret.

No external vision server, GPU, VPS, or paid API key is required for the normal free-allocation path.

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

Telegram bootstrap:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

After `/whoami` returns your Telegram numeric user ID:

```bash
npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS
```

Never place credentials in `wrangler.toml`, README, logs, or Git.

---

## D. Apply migrations

```bash
npm run db:migrate:remote
```

Current migrations:

```text
0001_init.sql
0002_candidates.sql
0003_delivery_receipt.sql
0004_telegram_entry.sql
0005_telegram_image_choices.sql
```

`0005` stores only temporary recognition choices/metadata; the source image itself is not persisted there.

---

## E. Deploy

```bash
npm run typecheck
npm run deploy
```

Health check:

```bash
curl https://<your-worker>.workers.dev/health
```

Expected configured components include Gmail, Telegram, and `vision: workers_ai`.

---

## F. Telegram webhook

Register:

```text
https://<your-worker>.workers.dev/telegram/webhook
```

Use the same `TELEGRAM_WEBHOOK_SECRET` as Telegram's `secret_token` and allow only:

```text
message
callback_query
```

See [`TELEGRAM.md`](TELEGRAM.md) for detailed setup and acceptance tests.

---

## G. Cloud resource guardrails

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
- image bytes are bounded before base64/AI inference;
- images are JPEG/PNG/WebP signature-checked;
- vision failures are not automatically retried, avoiding duplicate AI cost/buttons;
- ebook bytes stay in R2, never D1;
- D1 contains task/recognition metadata only;
- no Docker/Calibre/native binaries are required in the Cloudflare core path.

Cloudflare Workers AI currently provides a free daily allocation of 10,000 Neurons; usage resets daily. The vision feature is invoked only for authorized users who send images.

---

## H. Production acceptance checklist

Before considering v0.4 complete in a real deployment:

- [ ] All migrations `0001` through `0005` applied.
- [ ] Existing text -> Kindle path still passes.
- [ ] Gmail sender remains approved by Amazon Send to Kindle.
- [ ] Telegram webhook secret verification passes.
- [ ] `TELEGRAM_ALLOWED_USER_IDS` blocks unauthorized users.
- [ ] Workers AI binding appears in deployment.
- [ ] Meta vision-model license accepted once.
- [ ] Clear single-book cover is recognized and creates a normal task.
- [ ] Multi-book screenshot creates image-selection buttons.
- [ ] Low-confidence result requires confirmation instead of blind send.
- [ ] Non-book image creates no book task.
- [ ] Oversized/invalid image is rejected before AI inference.
- [ ] Image caption `PDF`, `中文`, or `英文` survives recognition/selection.
- [ ] Source-edition ambiguity still produces the existing candidate buttons.
- [ ] Final Kindle delivery still produces Telegram `delivered` notification.
- [ ] `delivery_unknown` never triggers blind automatic resend.
- [ ] GitHub Actions CI is green.
