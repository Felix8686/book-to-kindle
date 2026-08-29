import type { Env } from "./domain";

export interface UserBookSettings {
  defaultLanguage: "zh" | "en";
  preferredFormat: "epub" | "pdf";
}

const DEFAULT_SETTINGS: UserBookSettings = {
  defaultLanguage: "zh",
  preferredFormat: "epub",
};

function allowedUserIds(env: Env): Set<string> {
  return new Set(
    (env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function isAllowedUser(env: Env, userId: string): boolean {
  const allowed = allowedUserIds(env);
  return allowed.size > 0 && allowed.has(userId);
}

export function normalizeBookLanguage(value?: string): "zh" | "en" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["zh", "zh-cn", "zh-hans", "chi", "zho", "chinese", "中文", "中文版"].includes(normalized)) {
    return "zh";
  }
  if (["en", "eng", "english", "英文", "英语"].includes(normalized)) return "en";
  return undefined;
}

export class UserSettingsRepository {
  constructor(private readonly db: D1Database) {}

  async get(userId: string): Promise<UserBookSettings> {
    const row = await this.db
      .prepare(
        `SELECT default_language, preferred_format
         FROM user_settings WHERE user_id = ?1`,
      )
      .bind(userId)
      .first<Record<string, unknown>>();

    if (!row) return { ...DEFAULT_SETTINGS };

    return {
      defaultLanguage: normalizeBookLanguage(String(row.default_language)) ?? "zh",
      preferredFormat: String(row.preferred_format).toLowerCase() === "pdf" ? "pdf" : "epub",
    };
  }

  async setLanguage(userId: string, language: "zh" | "en"): Promise<UserBookSettings> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO user_settings
           (user_id, default_language, preferred_format, created_at, updated_at)
         VALUES (?1, ?2, 'epub', ?3, ?3)
         ON CONFLICT(user_id) DO UPDATE SET
           default_language = excluded.default_language,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, language, now)
      .run();
    return this.get(userId);
  }
}

export async function preferredLanguageForTask(
  env: Env,
  taskId: string,
  explicitLanguage?: string,
): Promise<"zh" | "en"> {
  const explicit = normalizeBookLanguage(explicitLanguage);
  if (explicit) return explicit;

  const link = await env.DB
    .prepare(`SELECT user_id FROM telegram_task_links WHERE task_id = ?1`)
    .bind(taskId)
    .first<Record<string, unknown>>();

  if (!link?.user_id) return "zh";
  return (await new UserSettingsRepository(env.DB).get(String(link.user_id))).defaultLanguage;
}

interface TelegramUser {
  id: number;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

function telegramApiUrl(env: Env, method: string): string {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function sendTelegramMessage(
  env: Env,
  chatId: string,
  text: string,
  replyToMessageId: number,
): Promise<void> {
  const response = await fetch(telegramApiUrl(env, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4096),
      reply_to_message_id: replyToMessageId,
    }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}.`);
}

async function claimTelegramUpdate(env: Env, updateId: number): Promise<boolean> {
  const result = await env.DB
    .prepare(
      `INSERT INTO telegram_updates (update_id, received_at)
       VALUES (?1, ?2)
       ON CONFLICT(update_id) DO NOTHING`,
    )
    .bind(updateId, new Date().toISOString())
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

function languageCommand(text: string): "zh" | "en" | "invalid" | null {
  const slash = text.match(/^\/language(?:@\w+)?(?:\s+(.+))?$/i);
  const chinese = text.match(/^\/语言(?:\s+(.+))?$/u);
  if (!slash && !chinese) return null;
  const raw = (slash?.[1] ?? chinese?.[1] ?? "").trim();
  if (!raw) return "invalid";
  return normalizeBookLanguage(raw) ?? "invalid";
}

export async function handleTelegramSettingsWebhook(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return null;

  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || secret !== env.TELEGRAM_WEBHOOK_SECRET) return null;

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return null;
  }

  if (!Number.isInteger(update.update_id) || update.update_id < 0) return null;
  const message = update.message;
  const text = message?.text?.trim();
  if (!message?.from || !text || message.chat.type !== "private") return null;

  const isSettings = /^\/settings(?:@\w+)?\s*$/i.test(text);
  const requestedLanguage = languageCommand(text);
  if (!isSettings && requestedLanguage === null) return null;

  const userId = String(message.from.id);
  if (!isAllowedUser(env, userId)) return null;
  if (!(await claimTelegramUpdate(env, update.update_id))) return new Response("ok");

  const repo = new UserSettingsRepository(env.DB);
  if (isSettings) {
    const settings = await repo.get(userId);
    await sendTelegramMessage(
      env,
      String(message.chat.id),
      [
        "Book to Kindle 设置",
        "",
        `默认书籍语言：${settings.defaultLanguage === "zh" ? "中文优先" : "英文优先"}`,
        `默认格式：${settings.preferredFormat.toUpperCase()}`,
        "",
        "修改语言：/language zh 或 /language en",
        "单条消息中的“中文/英文”会临时覆盖默认值，但不会修改这里的设置。",
      ].join("\n"),
      message.message_id,
    );
    return new Response("ok");
  }

  if (requestedLanguage === null || requestedLanguage === "invalid") {
    await sendTelegramMessage(
      env,
      String(message.chat.id),
      "语言参数无效。请使用 /language zh 或 /language en，也可以输入 /语言 中文 或 /语言 英文。",
      message.message_id,
    );
    return new Response("ok");
  }

  const settings = await repo.setLanguage(userId, requestedLanguage);
  await sendTelegramMessage(
    env,
    String(message.chat.id),
    `默认书籍语言已改为：${settings.defaultLanguage === "zh" ? "中文优先" : "英文优先"}。`,
    message.message_id,
  );
  return new Response("ok");
}
