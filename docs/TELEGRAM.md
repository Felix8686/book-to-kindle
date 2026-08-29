# Telegram entrypoint

Book to Kindle v0.3 adds a Telegram Bot webhook directly to the Cloudflare Worker.

The intended path is:

```text
Telegram user
    |
    v
/telegram/webhook
    |
    v
Cloudflare Worker
    |
    +--> D1 task + Telegram task mapping
    |
    +--> Queue
            |
            v
      normal book workflow
            |
            v
          Kindle
```

Hermes is not required for this path. The Telegram bot remains usable while the user's PC is off.

## 1. Create a bot

Create a bot with Telegram's official `@BotFather` and obtain the bot token.

Do not commit the token to Git.

## 2. Generate a webhook secret

Telegram `setWebhook` supports a `secret_token`. Telegram then includes the value in the `X-Telegram-Bot-Api-Secret-Token` request header. The Worker rejects webhook calls whose header does not match.

The secret may only contain `A-Z`, `a-z`, `0-9`, `_` and `-`.

One way to generate a suitable value locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Keep this value private.

## 3. Configure Cloudflare secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

`TELEGRAM_ALLOWED_USER_IDS` is deliberately configured separately after `/whoami` is available.

## 4. Apply the Telegram migration

The Telegram entrypoint uses `migrations/0004_telegram_entry.sql`.

```bash
npm run db:migrate:remote
```

For local development:

```bash
npm run db:migrate:local
```

## 5. Deploy

```bash
npm run deploy
```

Verify:

```text
GET https://<worker>.workers.dev/health
```

The response should contain:

```json
{
  "telegram": "configured"
}
```

This only means the bot token and webhook secret exist. User authorization is controlled separately.

## 6. Register the webhook

Webhook URL:

```text
https://<worker>.workers.dev/telegram/webhook
```

Register only the update types currently used by the project:

- `message`
- `callback_query`

Example with curl:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<worker>.workers.dev/telegram/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message", "callback_query"],
    "drop_pending_updates": true
  }'
```

PowerShell example:

```powershell
$body = @{
  url = "https://<worker>.workers.dev/telegram/webhook"
  secret_token = "<TELEGRAM_WEBHOOK_SECRET>"
  allowed_updates = @("message", "callback_query")
  drop_pending_updates = $true
} | ConvertTo-Json

Invoke-RestMethod \
  -Method Post \
  -Uri "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -ContentType "application/json" \
  -Body $body
```

A successful response contains `"ok": true`.

## 7. Find your Telegram user ID

Before the allowlist is configured, `/whoami` is intentionally still available.

Open a private chat with the bot and send:

```text
/whoami
```

The bot replies with your numeric Telegram user ID.

Other task commands remain blocked until an allowlist is configured.

## 8. Configure the allowlist

For a personal deployment:

```bash
npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS
```

Enter the numeric ID returned by `/whoami`.

Multiple users may be comma-separated:

```text
123456789,987654321
```

If this secret is empty or absent, nobody can create book tasks through Telegram. `/whoami` remains available so the deployment can be bootstrapped safely.

## 9. User experience

The bot currently supports private chats only.

### Direct title

```text
Pride and Prejudice
```

### Natural-language request

```text
把《Pride and Prejudice》发到 Kindle
```

### Format preference

```text
《The Little Prince》 PDF
```

EPUB is the default format preference.

### Explicit command

```text
/send Pride and Prejudice
```

### Check the latest task

```text
/status
```

### Help

```text
/help
```

## 10. Ambiguous editions

If the workflow reaches `needs_selection`, Telegram sends inline buttons for the highest-ranked candidates.

Selecting a button:

1. verifies the Telegram user matches the original requester;
2. verifies the callback comes from the original chat;
3. records the selected candidate;
4. re-queues the same task;
5. continues download and delivery.

No new search task is created.

## 11. Automatic notifications

Telegram-linked tasks currently notify on these states:

- `needs_selection`
- `needs_source`
- `staged` when delivery is not configured
- `delivered`
- `delivery_unknown`
- `failed`

A `last_notified_status` field prevents the same terminal/waiting state from repeatedly generating identical notifications during queue retries.

## 12. Security decisions

- Telegram webhook calls do **not** use the normal API bearer token.
- The webhook is authenticated using Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
- Task creation requires `TELEGRAM_ALLOWED_USER_IDS`.
- Only private chats are accepted.
- Inline candidate selections are tied to both the original Telegram user and chat.
- Bot token, webhook secret and user allowlist belong in Wrangler secrets / `.dev.vars`, not Git.
- Telegram is only an entry/notification adapter; the core book workflow remains provider-neutral.

## 13. Local development

Add to `.dev.vars`:

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

Telegram requires a public HTTPS webhook URL, so a plain `localhost` Wrangler server cannot receive Telegram webhooks directly. For local Telegram testing, use a secure HTTPS tunnel or deploy a temporary Worker environment.

The non-Telegram API remains fully testable locally without a tunnel.
