import type { DeliveryAdapter, Env } from "../domain";

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

function encodeHeader(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function asciiFilename(title: string, extension: string): string {
  const normalized = title
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .slice(0, 80);
  return `${normalized || "book"}.${extension}`;
}

function mimeStream(input: {
  object: R2ObjectBody;
  from: string;
  to: string;
  title: string;
  extension: string;
  contentType: string;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const boundary = `book-to-kindle-${crypto.randomUUID()}`;
  const fallbackFilename = asciiFilename(input.title, input.extension);
  const utf8Filename = encodeURIComponent(`${input.title}.${input.extension}`);

  const prefix =
    `From: ${input.from}\r\n` +
    `To: ${input.to}\r\n` +
    `Subject: ${encodeHeader(input.title)}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n` +
    `\r\n` +
    `Delivered by book-to-kindle.\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${input.contentType}; name="${fallbackFilename}"\r\n` +
    `Content-Disposition: attachment; filename="${fallbackFilename}"; filename*=UTF-8''${utf8Filename}\r\n` +
    `Content-Transfer-Encoding: binary\r\n` +
    `\r\n`;

  const suffix = `\r\n--${boundary}--\r\n`;
  const source = input.object.body;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(prefix));
      const reader = source.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.enqueue(encoder.encode(suffix));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

async function getAccessToken(env: Env): Promise<string> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error("Gmail OAuth credentials are incomplete.");
  }

  const body = new URLSearchParams({
    client_id: env.GMAIL_CLIENT_ID,
    client_secret: env.GMAIL_CLIENT_SECRET,
    refresh_token: env.GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await response.json()) as TokenResponse;

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Gmail OAuth refresh failed: ${data.error_description || data.error || `HTTP ${response.status}`}`,
    );
  }

  return data.access_token;
}

export function isGmailConfigured(env: Env): boolean {
  return Boolean(
    env.GMAIL_CLIENT_ID &&
      env.GMAIL_CLIENT_SECRET &&
      env.GMAIL_REFRESH_TOKEN &&
      env.GMAIL_FROM_EMAIL,
  );
}

export class GmailDelivery implements DeliveryAdapter {
  readonly name = "gmail";

  constructor(private readonly env: Env) {}

  async deliver(input: {
    task: Parameters<DeliveryAdapter["deliver"]>[0]["task"];
    object: R2ObjectBody;
    kindleEmail: string;
  }): Promise<void> {
    if (!this.env.GMAIL_FROM_EMAIL) throw new Error("GMAIL_FROM_EMAIL is not configured.");
    const selected = input.task.selectedCandidate;
    if (!selected) throw new Error("Task has no selected candidate to deliver.");

    const token = await getAccessToken(this.env);
    const contentType = input.object.httpMetadata?.contentType || "application/octet-stream";
    const message = mimeStream({
      object: input.object,
      from: this.env.GMAIL_FROM_EMAIL,
      to: input.kindleEmail,
      title: selected.title,
      extension: selected.format,
      contentType,
    });

    const response = await fetch(
      "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "message/rfc822",
        },
        body: message,
      },
    );

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      throw new Error(`Gmail delivery failed with HTTP ${response.status}: ${detail}`);
    }
  }
}
