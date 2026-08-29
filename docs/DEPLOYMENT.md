# Deployment

This project supports local and Cloudflare execution from the same codebase.

## A. Local mode

Use local mode for development, testing, or running the workflow on a machine/NAS without deploying to Cloudflare.

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
```

See [`GMAIL_OAUTH.md`](GMAIL_OAUTH.md) for OAuth setup.

### 3. Apply D1 migrations

```bash
npm run db:migrate:local
```

This applies the task schema, candidate persistence, and delivery-receipt migration.

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

If a task reaches `delivery_unknown`, do not blindly resend it. Check Gmail Sent and the Kindle library first; the state deliberately blocks automatic resend because the previous delivery may already have succeeded.

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

### 5. Configure secrets

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put KINDLE_EMAIL
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
npx wrangler secret put GMAIL_FROM_EMAIL
```

Never place OAuth credentials in `wrangler.toml` or commit them to Git.

### 6. Apply migrations

```bash
npm run db:migrate:remote
```

This applies all current migrations, including candidate lists and Gmail delivery receipts.

### 7. Deploy

```bash
npm run deploy
```

### 8. Verify

```bash
curl https://<your-worker>.workers.dev/health
```

A fully configured deployment should report Gmail delivery as configured.

### 9. Run an end-to-end test

Submit the same `Pride and Prejudice` request used in local mode, then poll its task ID until it reaches `delivered`, `delivery_unknown`, `needs_selection`, `needs_source`, or `failed`.

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

Before exposing the service publicly:

- [ ] Replace the placeholder D1 database ID.
- [ ] Configure a strong `API_TOKEN`.
- [ ] Apply all D1 migrations (`0001` through `0003`).
- [ ] Configure Gmail OAuth secrets.
- [ ] Confirm the Gmail sender is permitted by Amazon Send to Kindle settings.
- [ ] Verify the correct Kindle Send-to-Kindle email address.
- [ ] Run at least one successful public-domain EPUB delivery.
- [ ] Verify the response contains a delivery receipt when Gmail returns message metadata.
- [ ] Verify `needs_selection` can be resolved through the selection API.
- [ ] Verify `delivery_unknown` never causes an automatic resend.
- [ ] Configure an R2 lifecycle rule as a second safety net for stale temporary objects.
- [ ] Keep Telegram disabled until webhook secret verification is implemented.
- [ ] Review queue/dead-letter failures before adding explicit retry controls for uncertain delivery.
