import type {
  BookCandidate,
  BookRequest,
  Env,
  TaskRecord,
  TelegramImageQueueMessage,
} from "./domain";
import { TaskRepository } from "./repository";

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct" as const;
const DEFAULT_MAX_TELEGRAM_IMAGE_BYTES = 4 * 1024 * 1024;
const HARD_MAX_TELEGRAM_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_CHOICE_TTL_HOURS = 24;

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
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

interface RecognizedBook {
  title: string;
  author?: string;
  language?: string;
  confidence: number;
  requestLanguage?: string;
  preferredFormat?: "epub" | "pdf";
}

interface TelegramImageChoiceRecord {
  id: string;
  chatId: string;
  userId: string;
  sourceMessageId?: number;
  choices: RecognizedBook[];
  expiresAt: string;
}

interface TelegramFileInfo {
  file_id?: string;
  file_size?: number;
  file_path?: string;
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
      .bind(input.taskId, input.chatId, input.userId, input.sourceMessageId ?? null, now)
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

class TelegramImageChoiceRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: {
    chatId: string;
    userId: string;
    sourceMessageId?: number;
    choices: RecognizedBook[];
  }): Promise<TelegramImageChoiceRecord> {
    const id = crypto.randomUUID();
    const now = new Date();
    const expires = new Date(now.getTime() + IMAGE_CHOICE_TTL_HOURS * 60 * 60 * 1000);

    await this.db
      .prepare(`DELETE FROM telegram_image_choices WHERE expires_at < ?1`)
      .bind(now.toISOString())
      .run();

    await this.db
      .prepare(
        `INSERT INTO telegram_image_choices
           (id, chat_id, user_id, source_message_id, choices_json, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        id,
        input.chatId,
        input.userId,
        input.sourceMessageId ?? null,
        JSON.stringify(input.choices),
        now.toISOString(),
        expires.toISOString(),
      )
      .run();

    return {
      id,
      chatId: input.chatId,
      userId: input.userId,
      sourceMessageId: input.sourceMessageId,
      choices: input.choices,
      expiresAt: expires.toISOString(),
    };
  }

  async get(id: string): Promise<TelegramImageChoiceRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, chat_id, user_id, source_message_id, choices_json, expires_at
         FROM telegram_image_choices WHERE id = ?1`,
      )
      .bind(id)
      .first<Record<string, unknown>>();

    if (!row) return null;
    if (Date.parse(String(row.expires_at)) <= Date.now()) {
      await this.delete(id);
      return null;
    }

    let choices: RecognizedBook[];
    try {
      choices = JSON.parse(String(row.choices_json)) as RecognizedBook[];
    } catch {
      await this.delete(id);
      return null;
    }

    return {
      id: String(row.id),
      chatId: String(row.chat_id),
      userId: String(row.user_id),
      sourceMessageId:
        row.source_message_id === null || row.source_message_id === undefined
          ? undefined
          : Number(row.source_message_id),
      choices,
      expiresAt: String(row.expires_at),
    };
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM telegram_image_choices WHERE id = ?1`).bind(id).run();
  }
}

class TelegramUpdateRepository {
  constructor(private readonly db: D1Database) {}

  async claim(updateId: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO telegram_updates (update_id, received_at)
         VALUES (?1, ?2)
         ON CONFLICT(update_id) DO NOTHING`,
      )
      .bind(updateId, new Date().toISOString())
      .run();

    return Number(result.meta.changes ?? 0) > 0;
  }

  async release(updateId: number): Promise<void> {
    await this.db.prepare(`DELETE FROM telegram_updates WHERE update_id = ?1`).bind(updateId).run();
  }
}

class TelegramQueueEnqueueError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TelegramQueueEnqueueError";
  }
}

function telegramApiUrl(env: Env, method: string): string {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

function telegramFileUrl(env: Env, filePath: string): string {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const safePath = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${safePath}`;
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
    throw new Error(`Telegram ${method} failed: ${data.description || `HTTP ${response.status}`}`);
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

function maxTelegramImageBytes(env: Env): number {
  const configured = Number(env.MAX_TELEGRAM_IMAGE_BYTES);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_TELEGRAM_IMAGE_BYTES;
  return Math.min(configured, HARD_MAX_TELEGRAM_IMAGE_BYTES);
}

function cleanTitle(value: string): string {
  return value
    .replace(/^[\s：:,，;；-]+|[\s：:,，;；-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function explicitLanguage(text?: string): string | undefined {
  if (!text) return undefined;
  if (/(?:中文|中文版|chinese)/i.test(text)) return "zh";
  if (/(?:英文|英语|english)/i.test(text)) return "en";
  return undefined;
}

function explicitFormat(text?: string): "epub" | "pdf" {
  return text && /\bpdf\b/i.test(text) ? "pdf" : "epub";
}

export function parseTelegramBookRequest(text: string): BookRequest | null {
  const original = text.trim();
  if (!original) return null;
  if (original.startsWith("/") && !/^\/(?:send|book)(?:@\w+)?\s+/i.test(original)) {
    return null;
  }

  const authorMatch = original.match(/(?:作者|author)\s*[：:]?\s*([^\n,，;；]+)/i);
  const author = authorMatch?.[1]?.trim().slice(0, 200);
  const language = explicitLanguage(original);
  const preferredFormat = explicitFormat(original);
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

  return { query: cleaned, author, language, preferredFormat };
}

function helpText(): string {
  return [
    "Book to Kindle 已连接。",
    "",
    "可以直接发送书名，也可以发送清晰的书籍封面/截图。",
    "例如：",
    "把《Pride and Prejudice》发到 Kindle",
    "Pride and Prejudice",
    "《The Little Prince》 PDF",
    "或者直接发一张书封面图片。",
    "",
    "图片说明文字可写：PDF、中文、英文等偏好。",
    "若图片里有多本书或识别不够确定，机器人会让你点选。",
    "",
    "命令：",
    "/send <书名>  创建任务",
    "/status  查看最近任务",
    "/whoami  查看你的 Telegram user ID",
    "/help  查看帮助",
  ].join("\n");
}

function candidateLabel(candidate: BookCandidate, index: number): string {
  const details = [candidate.format.toUpperCase(), candidate.language].filter(Boolean).join(" · ");
  const label = `${index + 1}. ${candidate.title}${details ? ` · ${details}` : ""}`;
  return label.length > 60 ? `${label.slice(0, 57)}...` : label;
}

function selectionKeyboard(task: TaskRecord): TelegramSendOptions["reply_markup"] | undefined {
  if (!task.candidates?.length) return undefined;
  return {
    inline_keyboard: task.candidates.slice(0, 5).map((candidate, index) => [
      { text: candidateLabel(candidate, index), callback_data: `sel:${task.id}:${index}` },
    ]),
  };
}

function imageChoiceLabel(book: RecognizedBook, index: number): string {
  const author = book.author ? ` · ${book.author}` : "";
  const value = `${index + 1}. ${book.title}${author}`;
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function imageChoiceKeyboard(
  record: TelegramImageChoiceRecord,
): TelegramSendOptions["reply_markup"] {
  return {
    inline_keyboard: [
      ...record.choices.slice(0, 5).map((book, index) => [
        { text: imageChoiceLabel(book, index), callback_data: `img:${record.id}:${index}` },
      ]),
      [{ text: "取消", callback_data: `img:${record.id}:x` }],
    ],
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
    case "cancelled":
      return `《${title}》已被取消。`;
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

async function sendTaskStatus(env: Env, chatId: string, task: TaskRecord): Promise<void> {
  await sendTelegramMessage(env, chatId, taskStatusText(task), {
    reply_markup: task.status === "needs_selection" ? selectionKeyboard(task) : undefined,
  });
}

async function createTelegramBookTask(input: {
  env: Env;
  chatId: string;
  userId: string;
  sourceMessageId?: number;
  request: BookRequest;
}): Promise<string> {
  const taskId = crypto.randomUUID();
  await new TaskRepository(input.env.DB).create(taskId, input.request);
  await new TelegramTaskLinkRepository(input.env.DB).create({
    taskId,
    chatId: input.chatId,
    userId: input.userId,
    sourceMessageId: input.sourceMessageId,
  });
  try {
    await input.env.TASK_QUEUE.send({ kind: "book", taskId });
  } catch (error) {
    // No Queue side effect was confirmed, so remove the incomplete task and
    // let Telegram retry this update instead of leaving it stuck in queued.
    await input.env.DB.batch([
      input.env.DB.prepare(`DELETE FROM telegram_task_links WHERE task_id = ?1`).bind(taskId),
      input.env.DB.prepare(`DELETE FROM tasks WHERE id = ?1`).bind(taskId),
    ]);
    throw new TelegramQueueEnqueueError("Could not enqueue Telegram book task.", { cause: error });
  }
  return taskId;
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

function supportedDocumentImage(document?: TelegramDocument): boolean {
  if (!document?.mime_type) return false;
  return ["image/jpeg", "image/png", "image/webp"].includes(document.mime_type.toLowerCase());
}

function chooseTelegramImage(message: TelegramMessage): {
  fileId: string;
  declaredSizeBytes?: number;
  mimeType?: string;
} | null {
  if (message.photo?.length) {
    const largest = [...message.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return {
      fileId: largest.file_id,
      declaredSizeBytes: largest.file_size,
      mimeType: "image/jpeg",
    };
  }

  if (supportedDocumentImage(message.document)) {
    return {
      fileId: message.document!.file_id,
      declaredSizeBytes: message.document!.file_size,
      mimeType: message.document!.mime_type,
    };
  }

  return null;
}

async function handleMessage(env: Env, message: TelegramMessage): Promise<void> {
  if (!message.from) return;
  const chatId = String(message.chat.id);
  const userId = String(message.from.id);
  const text = message.text?.trim();

  if (message.chat.type !== "private") {
    await sendTelegramMessage(env, chatId, "目前只支持与机器人私聊使用。", {
      reply_to_message_id: message.message_id,
    });
    return;
  }

  if (text && /^\/whoami(?:@\w+)?(?:\s|$)/i.test(text)) {
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

  if (text && /^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(text)) {
    await sendTelegramMessage(env, chatId, helpText());
    return;
  }

  if (text && /^\/status(?:@\w+)?(?:\s|$)/i.test(text)) {
    await handleStatusCommand(env, message, userId);
    return;
  }

  const image = chooseTelegramImage(message);
  if (image) {
    const maxBytes = maxTelegramImageBytes(env);
    if (image.declaredSizeBytes && image.declaredSizeBytes > maxBytes) {
      await sendTelegramMessage(
        env,
        chatId,
        `图片太大，当前识图上限约为 ${(maxBytes / 1024 / 1024).toFixed(0)} MiB。请以“照片”方式发送，或先压缩图片。`,
        { reply_to_message_id: message.message_id },
      );
      return;
    }

    try {
      await env.TASK_QUEUE.send({
        kind: "telegram_image",
        chatId,
        userId,
        sourceMessageId: message.message_id,
        fileId: image.fileId,
        caption: message.caption?.trim().slice(0, 500),
        declaredSizeBytes: image.declaredSizeBytes,
        mimeType: image.mimeType,
      });
    } catch (error) {
      throw new TelegramQueueEnqueueError("Could not enqueue Telegram image task.", { cause: error });
    }

    await sendTelegramMessage(env, chatId, "收到图片，正在识别书名和作者……", {
      reply_to_message_id: message.message_id,
    });
    return;
  }

  if (!text) {
    await sendTelegramMessage(
      env,
      chatId,
      "暂时只支持文字、Telegram 照片，以及 JPEG/PNG/WebP 图片文件。",
      { reply_to_message_id: message.message_id },
    );
    return;
  }

  const bookRequest = parseTelegramBookRequest(text);
  if (!bookRequest) {
    await sendTelegramMessage(env, chatId, helpText(), {
      reply_to_message_id: message.message_id,
    });
    return;
  }

  await createTelegramBookTask({
    env,
    chatId,
    userId,
    sourceMessageId: message.message_id,
    request: bookRequest,
  });

  await sendTelegramMessage(
    env,
    chatId,
    `已收到《${bookRequest.query}》，开始查找并发送到 Kindle。`,
    { reply_to_message_id: message.message_id },
  );
}

async function handleSourceCandidateCallback(
  env: Env,
  callback: TelegramCallbackQuery,
  match: RegExpMatchArray,
): Promise<void> {
  if (!callback.message) {
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

  if (!link || link.userId !== userId || String(callback.message.chat.id) !== link.chatId || !task) {
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
  const latest = await repo.get(taskId);
  if (String(latest?.status) === "cancelled") {
    await answerCallbackQuery(env, callback.id, "任务已经取消，不能继续发送。");
    return;
  }
  await env.TASK_QUEUE.send({ kind: "book", taskId });

  await answerCallbackQuery(env, callback.id, "已选择，继续处理。");
  await sendTelegramMessage(
    env,
    String(callback.message.chat.id),
    `已选择《${selected.title}》${selected.format ? `（${selected.format.toUpperCase()}）` : ""}，继续发送。`,
  );
}

async function handleImageChoiceCallback(
  env: Env,
  callback: TelegramCallbackQuery,
  match: RegExpMatchArray,
): Promise<void> {
  if (!callback.message) {
    await answerCallbackQuery(env, callback.id, "这个按钮已失效。");
    return;
  }

  const userId = String(callback.from.id);
  if (!isAllowedUser(env, userId)) {
    await answerCallbackQuery(env, callback.id, "无权执行此操作。");
    return;
  }

  const choiceId = match[1];
  const selectedIndex = match[2];
  const choicesRepo = new TelegramImageChoiceRepository(env.DB);
  const record = await choicesRepo.get(choiceId);

  if (!record || record.userId !== userId || record.chatId !== String(callback.message.chat.id)) {
    await answerCallbackQuery(env, callback.id, "识图结果已过期或不属于你。");
    return;
  }

  if (selectedIndex === "x") {
    await choicesRepo.delete(choiceId);
    await answerCallbackQuery(env, callback.id, "已取消。");
    await sendTelegramMessage(env, record.chatId, "已取消这次图片识别任务。");
    return;
  }

  const book = record.choices[Number(selectedIndex)];
  if (!book) {
    await answerCallbackQuery(env, callback.id, "这个候选项已失效。");
    return;
  }

  const request: BookRequest = {
    query: book.title,
    author: book.author || undefined,
    language: book.requestLanguage,
    preferredFormat: book.preferredFormat ?? "epub",
  };

  await choicesRepo.delete(choiceId);
  await createTelegramBookTask({
    env,
    chatId: record.chatId,
    userId,
    sourceMessageId: record.sourceMessageId,
    request,
  });

  await answerCallbackQuery(env, callback.id, "已选择，开始处理。");
  await sendTelegramMessage(env, record.chatId, `已选择《${book.title}》，开始查找并发送到 Kindle。`);
}

async function handleCallbackQuery(env: Env, callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data ?? "";
  const sourceMatch = data.match(/^sel:([0-9a-f-]+):(\d+)$/i);
  if (sourceMatch) {
    await handleSourceCandidateCallback(env, callback, sourceMatch);
    return;
  }

  const imageMatch = data.match(/^img:([0-9a-f-]+):(\d+|x)$/i);
  if (imageMatch) {
    await handleImageChoiceCallback(env, callback, imageMatch);
    return;
  }

  await answerCallbackQuery(env, callback.id, "这个按钮已失效。");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    for (let i = offset; i < end; i += 1) binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function detectImageMime(bytes: Uint8Array, hinted?: string): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  const normalized = hinted?.split(";")[0].trim().toLowerCase();
  return normalized && ["image/jpeg", "image/png", "image/webp"].includes(normalized)
    ? normalized
    : null;
}

function normalizeRecognition(value: unknown): RecognizedBook[] {
  if (!value || typeof value !== "object") return [];
  const books = (value as { books?: unknown }).books;
  if (!Array.isArray(books)) return [];

  const seen = new Set<string>();
  const output: RecognizedBook[] = [];

  for (const raw of books.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === "string" ? cleanTitle(item.title) : "";
    if (!title) continue;
    const rawAuthor = typeof item.author === "string" ? item.author.trim().slice(0, 200) : "";
    const author = rawAuthor || undefined;
    const rawLanguage = typeof item.language === "string" ? item.language.trim().slice(0, 32) : "";
    const language = rawLanguage || undefined;
    const confidenceValue = Number(item.confidence);
    const confidence = Number.isFinite(confidenceValue)
      ? Math.max(0, Math.min(1, confidenceValue))
      : 0.5;
    const key = `${title.toLowerCase()}|${author?.toLowerCase() ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ title, author, language, confidence });
  }

  return output.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

async function recognizeBooksFromImage(
  env: Env,
  imageBytes: Uint8Array,
  mimeType: string,
  caption?: string,
): Promise<RecognizedBook[]> {
  const image = `data:${mimeType};base64,${bytesToBase64(imageBytes)}`;
  const prompt = [
    "Identify books that are visibly present in this image.",
    "Extract only titles that you can reasonably read or identify from the image itself.",
    "For each book return its title, author if visible/known from the cover, language if apparent, and confidence from 0 to 1.",
    "Do not invent a title from unrelated text. Return at most 5 books.",
    caption ? `The user added this caption: ${caption}` : "The user added no caption.",
  ].join("\n");

  // Cloudflare's runtime supports JSON Mode for this vision model, while the
  // generated Workers TypeScript declaration currently lags that documented field.
  const runVision = env.AI.run as unknown as (
    model: string,
    inputs: Record<string, unknown>,
  ) => Promise<unknown>;

  const raw = await runVision(VISION_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "You extract bibliographic information from book covers, reading-app screenshots, bookstore photos, and book-list screenshots. Be conservative when text is unclear.",
      },
      { role: "user", content: prompt },
    ],
    image,
    max_tokens: 384,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          books: {
            type: "array",
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                author: { type: "string" },
                language: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["title", "author", "language", "confidence"],
            },
          },
        },
        required: ["books"],
      },
    },
  });

  const response = (raw as { response?: unknown }).response;
  if (typeof response === "string") {
    try {
      return normalizeRecognition(JSON.parse(response));
    } catch {
      return [];
    }
  }
  return normalizeRecognition(response);
}

function shouldAutoSelectRecognition(books: RecognizedBook[]): boolean {
  if (books.length === 0) return false;
  if (books.length === 1) return books[0].confidence >= 0.78;
  return books[0].confidence >= 0.92 && books[1].confidence <= 0.55;
}

export async function processTelegramImageMessage(
  job: TelegramImageQueueMessage,
  env: Env,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram bot is not configured.");
  if (!isAllowedUser(env, job.userId)) return;

  const maxBytes = maxTelegramImageBytes(env);
  if (job.declaredSizeBytes && job.declaredSizeBytes > maxBytes) {
    await sendTelegramMessage(env, job.chatId, "图片超过识图大小限制，请压缩后重新发送。", {
      reply_to_message_id: job.sourceMessageId,
    });
    return;
  }

  try {
    const file = await telegramApi<TelegramFileInfo>(env, "getFile", { file_id: job.fileId });
    if (!file.file_path) throw new Error("Telegram did not return a file path.");
    if (file.file_size && file.file_size > maxBytes) {
      throw new Error("Image exceeds the configured vision size limit.");
    }

    const imageResponse = await fetch(telegramFileUrl(env, file.file_path));
    if (!imageResponse.ok) throw new Error(`Telegram image download failed with HTTP ${imageResponse.status}.`);

    const contentLength = Number(imageResponse.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error("Image exceeds the configured vision size limit.");
    }

    const buffer = await imageResponse.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error("Image exceeds the configured vision size limit.");
    if (buffer.byteLength === 0) throw new Error("Telegram returned an empty image.");

    const bytes = new Uint8Array(buffer);
    const mimeType = detectImageMime(
      bytes,
      imageResponse.headers.get("content-type") ?? job.mimeType,
    );
    if (!mimeType) throw new Error("Unsupported or invalid image format.");

    const books = await recognizeBooksFromImage(env, bytes, mimeType, job.caption);
    if (books.length === 0) {
      await sendTelegramMessage(
        env,
        job.chatId,
        "这张图片里没能可靠识别出书名。可以换一张更清晰的封面，或者直接发送书名。",
        { reply_to_message_id: job.sourceMessageId },
      );
      return;
    }

    if (shouldAutoSelectRecognition(books)) {
      const book = books[0];
      const request: BookRequest = {
        query: book.title,
        author: book.author || undefined,
        language: explicitLanguage(job.caption),
        preferredFormat: explicitFormat(job.caption),
      };
      await createTelegramBookTask({
        env,
        chatId: job.chatId,
        userId: job.userId,
        sourceMessageId: job.sourceMessageId,
        request,
      });
      await sendTelegramMessage(
        env,
        job.chatId,
        `识别到《${book.title}》${book.author ? `（${book.author}）` : ""}，开始查找并发送到 Kindle。`,
        { reply_to_message_id: job.sourceMessageId },
      );
      return;
    }

    const requestLanguage = explicitLanguage(job.caption);
    const preferredFormat = explicitFormat(job.caption);
    const choices = books.map((book) => ({
      ...book,
      requestLanguage,
      preferredFormat,
    }));
    const record = await new TelegramImageChoiceRepository(env.DB).create({
      chatId: job.chatId,
      userId: job.userId,
      sourceMessageId: job.sourceMessageId,
      choices,
    });
    await sendTelegramMessage(
      env,
      job.chatId,
      books.length === 1
        ? "识别到了一个可能的书名，但把握不够高，请确认："
        : "图片里识别到多本书，请选择要发送到 Kindle 的一本：",
      {
        reply_to_message_id: job.sourceMessageId,
        reply_markup: imageChoiceKeyboard(record),
      },
    );
  } catch (error) {
    console.error("Telegram image recognition failed", job.sourceMessageId, error);
    await sendTelegramMessage(
      env,
      job.chatId,
      "图片识别暂时失败。请稍后重发图片，或直接发送书名。",
      { reply_to_message_id: job.sourceMessageId },
    );
  }
}

export function isTelegramConfigured(env: Env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET);
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!isTelegramConfigured(env)) return new Response("telegram_not_configured", { status: 503 });
  if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });

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

  if (!Number.isInteger(update.update_id) || update.update_id < 0) {
    return new Response("invalid_update", { status: 400 });
  }

  const updates = new TelegramUpdateRepository(env.DB);
  try {
    if (!(await updates.claim(update.update_id))) return new Response("ok");

    if (update.message) await handleMessage(env, update.message);
    else if (update.callback_query) await handleCallbackQuery(env, update.callback_query);
  } catch (error) {
    if (error instanceof TelegramQueueEnqueueError) {
      try {
        await updates.release(update.update_id);
      } catch (releaseError) {
        console.error("Could not release failed Telegram update claim", update.update_id, releaseError);
      }
    }
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
