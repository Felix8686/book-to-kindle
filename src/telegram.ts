import type { BookCandidate, BookRequest, Env, TaskRecord } from "./domain";
import { TaskRepository } from "./repository";

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramTaskLink {
  taskId: string;
  chatId: string;
  userId: string;
  sourceMessageId?: number;
  lastNotifiedStatus?: string;
}

interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

interface TelegramSendOptions {
  reply_markup?: {
    inline_keyboard: InlineKeyboardButton[][];
  };
  reply_to_message_id?: number;
}

class TelegramTaskLinkRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: {
    taskId: string;
    chatId: string;
    userId: string;
    sourceMessageId?: number;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO telegram_task_links
           (task_id, chat_id, user_id, source_message_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(task_id) DO UPDATE SET
           chat_id = excluded.chat_id,
           user_id = excluded.user_id,
           source_message_id = excluded.source_message_id,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.taskId,
        input.chatId,
        input.userId,
        input.sourceMessageId ?? null,
        now,
      )
      .run();
  }

  async get(taskId: string): Promise<TelegramTaskLink | null> {
    const row = await this.db
      .prepare(
        `SELECT task_id, chat_id, user_id, source_message_id, last_notified_status
         FROM telegram_task_links WHERE task_id = ?1`,
      )
      .bind(taskId)
      .first<Record<string, unknown>>();

    if (!row) return null;
    return {
      taskId: String(row.task_id),
      chatId: String(row.chat_id),
      userId: String(row.user_id),
      sourceMessageId:
        row.source_message_id === null || row.source_message_id === undefined
          ? undefined
          : Number(row.source_message_id),
      lastNotifiedStatus: row.last_notified_status
        ? String(row.last_notified_status)
        : undefined,
    };
  }

  async latestForUser(userId: string): Promise<TelegramTaskLink | null> {
    const row = await this.db
      .prepare(
        `SELECT task_id, chat_id, user_id, source_message_id, last_notified_status
         FROM telegram_task_links
         WHERE user_id = ?1
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .bind(userId)
      .first<Record<string, unknown>>();

    if (!row) return null;
    return {
      taskId: String(row.task_id),
      chatId: String(row.chat_id),
      userId: String(row.user_id),
      sourceMessageId:
        row.source_message_id === null || row.source_message_id === undefined
          ? undefined
          : Number(row.source_message_id),
      lastNotifiedStatus: row.last_notified_status
        ? String(row.last_notified_status)
        : undefined,
    };
  }

  async markNotified(taskId: string, status: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE telegram_task_links
         SET last_notified_status = ?2, updated_at = ?3
         WHERE task_id = ?1`,
      )
      .bind(taskId, status, new Date().toISOString())
      .run();
  }
}

function telegramApiUrl(env: Env, method: string): string {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramApi<T>(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(telegramApiUrl(env, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram ${method} failed: ${data.description || `HTTP ${response.status}`}`,
    );
  }

  return data.result as T;
}

async function sendTelegramMessage(
  env: Env,
  chatId: string,
  text: string,
  options: TelegramSendOptions = {},
): Promise<void> {
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4096),
    ...options,
  });
}

async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: text.slice(0, 200) } : {}),
  });
}

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

function cleanTitle(value: string): string {
  return value
    .replace(/^\s*[：:,-]+|[：:,-]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function parseTelegramBookRequest(text: string): BookRequest | null {
  const original = text.trim();
  if (!original) return null;
  if (
    original.startsWith("/") &&
    !/^\/(?:send|book)(?:@\w+)?\s+/i.test(original)
  ) {
    return null;
  }

  const authorMatch = original.match(/(?:作者|author)\s*[：:]?\s*([^\n,，;；]+)/i);
  const author = authorMatch?.[1]?.trim().slice(0, 200);

  const language = /(?:中文|中文版|chinese)/i.test(original)
    ? "zh"
    : /(?:英文|英语|english)/i.test(original)
      ? "en"
      : undefined;

  const preferredFormat = /\bpdf\b/i.test(original) ? "pdf" : "epub";

  const chineseQuoted = original.match(/《([^》]{1,300})》/);
  const englishQuoted = original.match(/["“”']([^"“”']{1,300})["“”']/);
  let query = chineseQuoted?.[1] ?? englishQuoted?.[1];

  if (!query) {
    query = original
      .replace(/^\/(?:send|book)(?:@\w+)?\s+/i, "")
      .replace(/^(?:请|麻烦)?(?:帮我)?(?:把)?\s*/u, "")
      .replace(/^我(?:想|要)(?:看|读)\s*/u, "")
      .replace(/^send(?:\s+me)?\s+/i, "")
      .replace(/(?:作者|author)\s*[：:]?\s*[^\n,，;；]+/gi, "")
      .replace(/(?:中文版|中文|英文|英语|chinese|english)/gi, "")
      .replace(/\b(?:epub|pdf)\b/gi, "")
      .replace(/(?:发|发送|推送|送|放)(?:给|到|至)?\s*(?:我的)?\s*kindle.*$/iu, "")
      .replace(/\s+(?:to|onto)\s+(?:my\s+)?kindle.*$/i, "")
      .replace(/kindle/gi, "");
  }

  const cleaned = cleanTitle(query);
  if (!cleaned) return null;

  return {
    query: cleaned,
    author,
    language,
    preferredFormat,
  };
}

function helpText(): string {
  return [
    "Book to Kindle 已连接。",
    "",
    "直接发送书名即可，例如：",
    "把《Pride and Prejudice》发到 Kindle",
    "Pride and Prejudice",
    "《The Little Prince》 PDF",
    "",
    "命令：",
    "/send <书名>  创建任务",
    "/status  查看最近任务",
    "/whoami  查看你的 Telegram user ID",
    "/help  查看帮助",
  ].join("\n");
}

function candidateLabel(candidate: BookCandidate, index: number): string {
  const details = [candidate.format.toUpperCase(), candidate.language]
    .filter(Boolean)
    .join(" · ");
  const label = `${index + 1}. ${candidate.title}${details ? ` · ${details}` : ""}`;
  return label.length > 60 ? `${label.slice(0, 57)}...` : label;
}

function selectionKeyboard(task: TaskRecord): TelegramSendOptions["reply_markup"] | undefined {
  if (!task.candidates?.length) return undefined;
  return {
    inline_keyboard: task.candidates.slice(0, 5).map((candidate, index) => [
      {
        text: candidateLabel(candidate, index),
        callback_data: `sel:${task.id}:${index}`,
      },
    ]),
  };
}

function taskStatusText(task: TaskRecord): string {
  const title = task.selectedCandidate?.title ?? task.request.query;

  switch (task.status) {
    case "queued":
    case "searching":
    case "downloading":
    case "staged":
    case "delivering":
      return `《${title}》正在处理中。\n当前状态：${task.status}`;
    case "needs_selection":
      return `《${task.request.query}》找到多个可能版本，请选择一个：`;
    case "needs_source":
      return `没有找到《${task.request.query}》的可用来源。`;
    case "delivered":
      return `《${title}》已发送到 Kindle。`;
    case "delivery_unknown":
      return [
        `《${title}》的 Gmail 投递结果无法确认。`,
        "为避免 Kindle 收到重复文档，系统已停止自动重发。",
      ].join("\n");
    case "failed":
      return [
        `《${title}》处理失败。`,
        task.errorMessage ? `原因：${task.errorMessage.slice(0, 500)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
  }
}

async function sendTaskStatus(
  env: Env,
  chatId: string,
  task: TaskRecord,
): Promise<void> {
  await sendTelegramMessage(env, chatId, taskStatusText(task), {
    reply_markup: task.status === "needs_selection" ? selectionKeyboard(task) : undefined,
  });
}

async function handleStatusCommand(
  env: Env,
  message: TelegramMessage,
  userId: string,
): Promise<void> {
  const links = new TelegramTaskLinkRepository(env.DB);
  const repo = new TaskRepository(env.DB);
  const explicitTaskId = message.text?.trim().split(/\s+/)[1];
  const link = explicitTaskId ? await links.get(explicitTaskId) : await links.latestForUser(userId);

  if (!link || link.userId !== userId) {
    await sendTelegramMessage(env, String(message.chat.id), "没有找到可查看的任务。", {
      reply_to_message_id: message.message_id,
    });
    return;
  }

  const task = await repo.get(link.taskId);
  if (!task) {
    await sendTelegramMessage(env, String(message.chat.id), "任务记录不存在。", {
      reply_to_message_id: message.message_id,
    });
    return;
  }

  await sendTaskStatus(env, String(message.chat.id), task);
}

async function handleMessage(env: Env, message: TelegramMessage): Promise<void> {
  if (!message.from || !message.text) return;
  const chatId = String(message.chat.id);
  const userId = String(message.from.id);
  const text = message.text.trim();

  if (message.chat.type !== "private") {
    await sendTelegramMessage(env, chatId, "目前只支持与机器人私聊使用。", {
      reply_to_message_id: message.message_id,
    });
    return;
  }

  if (/^\/whoami(?:@\w+)?(?:\s|$)/i.test(text)) {
    await sendTelegramMessage(env, chatId, `你的 Telegram user ID：${userId}`, {
      reply_to_message_id: message.message_id,
    });
    return;
  }

  if (!isAllowedUser(env, userId)) {
    await sendTelegramMessage(
      env,
      chatId,
      [
        "当前账号尚未获准使用这个机器人。",
        `你的 Telegram user ID：${userId}`,
        "请把它加入 TELEGRAM_ALLOWED_USER_IDS 后再试。",
      ].join("\n"),
      { reply_to_message_id: message.message_id },
    );
    return;
  }

  if (/^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(text)) {
    await sendTelegramMessage(env, chatId, helpText());
    return;
  }

  if (/^\/status(?:@\w+)?(?:\s|$)/i.test(text)) {
    await handleStatusCommand(env, message, userId);
    return;
  }

  const bookRequest = parseTelegramBookRequest(text);
  if (!bookRequest) {
    await sendTelegramMessage(env, chatId, helpText(), {
      reply_to_message_id: message.message_id,
    });
    return;
  }

  const repo = new TaskRepository(env.DB);
  const links = new TelegramTaskLinkRepository(env.DB);
  const taskId = crypto.randomUUID();

  await repo.create(taskId, bookRequest);
  await links.create({
    taskId,
    chatId,
    userId,
    sourceMessageId: message.message_id,
  });
  await env.TASK_QUEUE.send({ taskId });

  await sendTelegramMessage(
    env,
    chatId,
    `已收到《${bookRequest.query}》，开始查找并发送到 Kindle。`,
    { reply_to_message_id: message.message_id },
  );
}

async function handleCallbackQuery(env: Env, callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data ?? "";
  const match = data.match(/^sel:([0-9a-f-]+):(\d+)$/i);
  if (!match || !callback.message) {
    await answerCallbackQuery(env, callback.id, "这个按钮已失效。");
    return;
  }

  const userId = String(callback.from.id);
  if (!isAllowedUser(env, userId)) {
    await answerCallbackQuery(env, callback.id, "无权执行此操作。");
    return;
  }

  const taskId = match[1];
  const candidateIndex = Number(match[2]);
  const links = new TelegramTaskLinkRepository(env.DB);
  const repo = new TaskRepository(env.DB);
  const link = await links.get(taskId);
  const task = await repo.get(taskId);

  if (
    !link ||
    link.userId !== userId ||
    String(callback.message.chat.id) !== link.chatId ||
    !task
  ) {
    await answerCallbackQuery(env, callback.id, "任务不存在或不属于你。");
    return;
  }

  if (task.status !== "needs_selection" || !task.candidates?.length) {
    await answerCallbackQuery(env, callback.id, "任务已经不需要选择。");
    return;
  }

  const selected = task.candidates[candidateIndex];
  if (!selected) {
    await answerCallbackQuery(env, callback.id, "这个候选项已失效。");
    return;
  }

  await repo.update(taskId, {
    status: "queued",
    candidates: null,
    selectedCandidate: selected,
    errorMessage: null,
  });
  await env.TASK_QUEUE.send({ taskId });

  await answerCallbackQuery(env, callback.id, "已选择，继续处理。");
  await sendTelegramMessage(
    env,
    String(callback.message.chat.id),
    `已选择《${selected.title}》${selected.format ? `（${selected.format.toUpperCase()}）` : ""}，继续发送。`,
  );
}

export function isTelegramConfigured(env: Env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET);
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!isTelegramConfigured(env)) {
    return new Response("telegram_not_configured", { status: 503 });
  }

  if (request.method !== "POST") {
    return new Response("method_not_allowed", { status: 405 });
  }

  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("invalid_json", { status: 400 });
  }

  try {
    if (update.message) await handleMessage(env, update.message);
    else if (update.callback_query) await handleCallbackQuery(env, update.callback_query);
  } catch (error) {
    console.error("Telegram update failed", update.update_id, error);
    return new Response("temporary_failure", { status: 500 });
  }

  return new Response("ok");
}

export async function notifyTelegramTaskState(taskId: string, env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const links = new TelegramTaskLinkRepository(env.DB);
  const link = await links.get(taskId);
  if (!link) return;

  const task = await new TaskRepository(env.DB).get(taskId);
  if (!task) return;

  const notifyStatuses = new Set([
    "needs_selection",
    "needs_source",
    "staged",
    "delivered",
    "delivery_unknown",
    "failed",
  ]);

  if (!notifyStatuses.has(task.status)) return;
  if (link.lastNotifiedStatus === task.status) return;

  await sendTaskStatus(env, link.chatId, task);
  await links.markNotified(taskId, task.status);
}
