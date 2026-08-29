import type { Env } from "./domain";
import { TaskRepository } from "./repository";

const CANCELLABLE_STATUSES = [
  "queued",
  "searching",
  "needs_source",
  "needs_selection",
  "downloading",
  "staged",
] as const;

const ACTIVE_CANCEL_CONTEXT_STATUSES = [
  ...CANCELLABLE_STATUSES,
  "delivering",
  "delivery_unknown",
] as const;

type CancelOutcome =
  | { outcome: "cancelled"; taskId: string; title: string }
  | { outcome: "too_late"; taskId: string; title: string; status: string }
  | { outcome: "not_cancellable"; taskId: string; title: string; status: string }
  | { outcome: "not_found"; taskId: string };

interface TelegramUser {
  id: number;
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

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

function titleOf(task: Awaited<ReturnType<TaskRepository["get"]>>): string {
  if (!task) return "这项任务";
  return task.selectedCandidate?.title ?? task.request.query;
}

export async function cancelTask(taskId: string, env: Env): Promise<CancelOutcome> {
  const repo = new TaskRepository(env.DB);
  const before = await repo.get(taskId);
  if (!before) return { outcome: "not_found", taskId };

  const status = String(before.status);
  const title = titleOf(before);

  if (["delivering", "delivery_unknown", "delivered"].includes(status)) {
    return { outcome: "too_late", taskId, title, status };
  }

  if (status === "cancelled") {
    return { outcome: "cancelled", taskId, title };
  }

  if (!CANCELLABLE_STATUSES.includes(status as (typeof CANCELLABLE_STATUSES)[number])) {
    return { outcome: "not_cancellable", taskId, title, status };
  }

  const placeholders = CANCELLABLE_STATUSES.map((_, index) => `?${index + 3}`).join(", ");
  const result = await env.DB
    .prepare(
      `UPDATE tasks
       SET status = 'cancelled', error_message = NULL, updated_at = ?2
       WHERE id = ?1 AND status IN (${placeholders})`,
    )
    .bind(taskId, new Date().toISOString(), ...CANCELLABLE_STATUSES)
    .run();

  if (Number(result.meta.changes ?? 0) === 0) {
    const latest = await repo.get(taskId);
    if (!latest) return { outcome: "not_found", taskId };
    const latestStatus = String(latest.status);
    const latestTitle = titleOf(latest);
    if (["delivering", "delivery_unknown", "delivered"].includes(latestStatus)) {
      return { outcome: "too_late", taskId, title: latestTitle, status: latestStatus };
    }
    if (latestStatus === "cancelled") {
      return { outcome: "cancelled", taskId, title: latestTitle };
    }
    return { outcome: "not_cancellable", taskId, title: latestTitle, status: latestStatus };
  }

  if (before.storageKey) {
    try {
      await env.FILES.delete(before.storageKey);
    } catch (error) {
      console.warn("Cancelled task R2 cleanup failed", taskId, error);
    }
  }

  return { outcome: "cancelled", taskId, title };
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

function telegramApiUrl(env: Env, method: string): string {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function sendTelegramMessage(
  env: Env,
  chatId: string,
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  const response = await fetch(telegramApiUrl(env, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4096),
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
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

function isCancelCommand(text: string): boolean {
  return (
    /^\/cancel(?:@\w+)?(?:\s|$)/i.test(text) ||
    /^(?:取消|撤回)(?:任务)?(?:\s|$)/u.test(text)
  );
}

function explicitTaskId(text: string): string | undefined {
  const slash = text.match(/^\/cancel(?:@\w+)?\s+([0-9a-f-]{36})\s*$/i);
  if (slash) return slash[1];
  const chinese = text.match(/^(?:取消|撤回)(?:任务)?\s+([0-9a-f-]{36})\s*$/iu);
  return chinese?.[1];
}

function hasCancelArgument(text: string): boolean {
  return (
    /^\/cancel(?:@\w+)?\s+\S+/i.test(text) ||
    /^(?:取消|撤回)(?:任务)?\s+\S+/u.test(text)
  );
}

async function linkedTaskForUser(
  env: Env,
  userId: string,
  taskId?: string,
): Promise<string | null> {
  if (taskId) {
    const row = await env.DB
      .prepare(`SELECT task_id FROM telegram_task_links WHERE task_id = ?1 AND user_id = ?2`)
      .bind(taskId, userId)
      .first<Record<string, unknown>>();
    return row ? String(row.task_id) : null;
  }

  const statusPlaceholders = ACTIVE_CANCEL_CONTEXT_STATUSES.map(
    (_, index) => `?${index + 2}`,
  ).join(", ");
  const row = await env.DB
    .prepare(
      `SELECT l.task_id
       FROM telegram_task_links l
       JOIN tasks t ON t.id = l.task_id
       WHERE l.user_id = ?1 AND t.status IN (${statusPlaceholders})
       ORDER BY l.created_at DESC
       LIMIT 1`,
    )
    .bind(userId, ...ACTIVE_CANCEL_CONTEXT_STATUSES)
    .first<Record<string, unknown>>();
  return row ? String(row.task_id) : null;
}

async function linkedCancelledTaskForStatus(
  env: Env,
  userId: string,
  taskId?: string,
): Promise<{ taskId: string; title: string } | null> {
  const row = taskId
    ? await env.DB
        .prepare(
          `SELECT l.task_id, t.request_json
           FROM telegram_task_links l
           JOIN tasks t ON t.id = l.task_id
           WHERE l.task_id = ?1 AND l.user_id = ?2 AND t.status = 'cancelled'`,
        )
        .bind(taskId, userId)
        .first<Record<string, unknown>>()
    : await env.DB
        .prepare(
          `SELECT l.task_id, t.request_json
           FROM telegram_task_links l
           JOIN tasks t ON t.id = l.task_id
           WHERE l.user_id = ?1
           ORDER BY l.created_at DESC
           LIMIT 1`,
        )
        .bind(userId)
        .first<Record<string, unknown>>();

  if (!row) return null;
  if (!taskId) {
    const current = await new TaskRepository(env.DB).get(String(row.task_id));
    if (!current || String(current.status) !== "cancelled") return null;
    return { taskId: current.id, title: titleOf(current) };
  }

  try {
    const request = JSON.parse(String(row.request_json)) as { query?: string };
    return { taskId: String(row.task_id), title: request.query || "这项任务" };
  } catch {
    return { taskId: String(row.task_id), title: "这项任务" };
  }
}

function helpText(): string {
  return [
    "Book to Kindle 已连接。",
    "",
    "直接发送书名或书籍图片即可创建任务。新用户默认中文版本优先、EPUB 优先。",
    "",
    "命令：",
    "/send <书名>  创建任务",
    "/status  查看最近任务",
    "/settings  查看默认书籍设置",
    "/language zh  默认中文优先",
    "/language en  默认英文优先",
    "/cancel  取消最近仍可取消的任务",
    "/cancel <task-id>  取消指定任务",
    "/whoami  查看你的 Telegram user ID",
    "/help  查看帮助",
    "",
    "单次消息里的“中文/英文”只覆盖当前任务，不修改默认设置。",
    "也可以直接发送“取消”或“撤回”。",
    "注意：一旦 Gmail 已经开始投递，就无法保证撤回。",
  ].join("\n");
}

function cancellationMessage(result: CancelOutcome): string {
  switch (result.outcome) {
    case "cancelled":
      return `已取消《${result.title}》。系统不会继续把它发送到 Kindle。`;
    case "too_late":
      if (result.status === "delivered") {
        return `《${result.title}》已经发送完成，无法从 Gmail/Kindle 远程撤回。`;
      }
      if (result.status === "delivery_unknown") {
        return `《${result.title}》的投递结果已经无法确认。为避免造成误判，不能标记为已撤回；请检查 Gmail 已发送邮件和 Kindle。`;
      }
      return `《${result.title}》已经进入 Gmail 投递阶段，当前已无法安全撤回。`;
    case "not_cancellable":
      return `《${result.title}》当前状态为 ${result.status}，没有可继续取消的处理。`;
    case "not_found":
      return "没有找到这个任务。";
  }
}

export async function handleTelegramControlWebhook(
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

  const message = update.message;
  const text = message?.text?.trim();
  if (!message?.from || !text || message.chat.type !== "private") return null;

  const userId = String(message.from.id);
  const chatId = String(message.chat.id);
  const isHelp = /^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(text);
  const isStatus = /^\/status(?:@\w+)?(?:\s|$)/i.test(text);
  const isCancel = isCancelCommand(text);

  if (!isHelp && !isStatus && !isCancel) return null;
  if (!isAllowedUser(env, userId)) return null;

  if (isStatus) {
    const requestedTaskId = text.split(/\s+/)[1];
    const cancelled = await linkedCancelledTaskForStatus(env, userId, requestedTaskId);
    if (!cancelled) return null;

    if (!(await claimTelegramUpdate(env, update.update_id))) return new Response("ok");
    await sendTelegramMessage(
      env,
      chatId,
      `《${cancelled.title}》已取消。\n任务 ID：${cancelled.taskId}`,
      message.message_id,
    );
    return new Response("ok");
  }

  if (!(await claimTelegramUpdate(env, update.update_id))) return new Response("ok");

  if (isHelp) {
    await sendTelegramMessage(env, chatId, helpText(), message.message_id);
    return new Response("ok");
  }

  const targeted = hasCancelArgument(text);
  const requestedTaskId = explicitTaskId(text);
  if (targeted && !requestedTaskId) {
    await sendTelegramMessage(
      env,
      chatId,
      "任务 ID 格式不正确。请使用 `/cancel <完整 task-id>`，或直接发送 `/cancel` 取消最近仍在处理的任务。",
      message.message_id,
    );
    return new Response("ok");
  }

  const taskId = await linkedTaskForUser(env, userId, requestedTaskId);
  if (!taskId) {
    await sendTelegramMessage(
      env,
      chatId,
      requestedTaskId ? "这个任务不存在或不属于你。" : "目前没有仍在处理、可供取消的任务。",
      message.message_id,
    );
    return new Response("ok");
  }

  const result = await cancelTask(taskId, env);
  await sendTelegramMessage(env, chatId, cancellationMessage(result), message.message_id);
  return new Response("ok");
}
