# Gmail OAuth setup

The Cloudflare delivery path uses the Gmail API instead of browser automation or SMTP passwords.

Required Worker secrets:

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `GMAIL_FROM_EMAIL`
- `KINDLE_EMAIL`

The OAuth token must include the Gmail send scope:

```text
https://www.googleapis.com/auth/gmail.send
```

## 1. Create a Google Cloud OAuth client

1. Create or select a Google Cloud project.
2. Enable the Gmail API.
3. Configure the OAuth consent screen.
4. Create an OAuth client ID.
5. For personal testing, a Desktop app client is usually the simplest choice.

Do not commit the client secret or refresh token to Git.

## 2. Obtain a refresh token

For manual setup, Google's OAuth 2.0 Playground can be used with your own OAuth client credentials:

1. Open Google OAuth 2.0 Playground.
2. Open its settings and enable **Use your own OAuth credentials**.
3. Enter the client ID and client secret created above.
4. Authorize the scope:

```text
https://www.googleapis.com/auth/gmail.send
```

5. Exchange the authorization code for tokens.
6. Save the returned refresh token.

For a long-running deployment, review your Google project's publishing/testing state because refresh-token lifetime can depend on OAuth app configuration.

## 3. Allow the Gmail sender in Kindle

The Gmail account represented by `GMAIL_FROM_EMAIL` must be permitted by your Amazon Send to Kindle / personal-document settings, and `KINDLE_EMAIL` must be the Send-to-Kindle address for the target Kindle account/device.

## 4. Configure local development

Create `.dev.vars`:

```dotenv
API_TOKEN=replace-with-a-long-random-secret
KINDLE_EMAIL=your-kindle-address@kindle.com
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_FROM_EMAIL=your-gmail-address@gmail.com
```

## 5. Configure Cloudflare

Store credentials as Wrangler secrets:

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put KINDLE_EMAIL
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
npx wrangler secret put GMAIL_FROM_EMAIL
```

## 6. Delivery behavior

The Worker refreshes a short-lived Gmail access token only when a delivery is needed. It then sends an RFC 822 MIME message through the Gmail media-upload endpoint.

The ebook body is streamed from R2 into the outbound MIME message rather than being fully loaded into Worker memory.

The current cloud guardrail is 20 MiB per ebook. This is intentionally below Gmail's personal-account attachment ceiling and can be lowered with `MAX_CLOUD_FILE_BYTES`.

## 7. First end-to-end test

Use a public-domain title such as *Pride and Prejudice*:

```bash
curl -X POST https://<your-worker>.workers.dev/api/v1/tasks \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"query":"Pride and Prejudice","author":"Jane Austen","language":"en","preferredFormat":"epub"}'
```

Poll the returned task ID:

```bash
curl https://<your-worker>.workers.dev/api/v1/tasks/<TASK_ID> \
  -H "Authorization: Bearer <API_TOKEN>"
```

Expected terminal state:

```text
delivered
```

If the state is `needs_selection`, choose one of the returned candidates through the selection endpoint documented in the README.
