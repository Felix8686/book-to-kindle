import type {
  BookRequest,
  Env,
  TaskQueueMessage,
  TaskRecord,
  TelegramAssistantTextQueueMessage,
} from "./domain";
import {
  decideAssistantAction,
  TelegramConversationRepository,
} from "./assistant";
import { TaskRepository } from "./repository";

const ASSISTANT_JOB_LEASE_MS = 5 * 60 * 1000;

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

interface AssistantJobRow {
  update_id: number;
  chat_id: string;
  user_id: string;
  source_message_id: number;
  input_text: string;
  state: "queued" | "processing" | "completed";
  lease_token?: string | null;
  lease_until?: string | null;
  task_id?: string | null;
  book_enqueued: number;
  response_text?: string | null;
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

  let detail = "";
  if (!response.ok) {
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      // Ignore response parsing failure and keep the HTTP status.
    }
    throw new Error(
      `Telegram sendMessage failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}.`,
    );
  }
}

function isAssistantFreeFormText(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  // Slash commands are owned by the deterministic Telegram command handlers.
  if (value.startsWith("/")) return false;
  // Chinese cancellation phrases are also deterministic controls.
  if (/^(?:取消|撤回)(?:任务)?(?:\s|$)/u.test(value)) return false;
  return true;
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

async function releaseTelegramUpdate(env: Env, updateId: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM telegram_updates WHERE update_id = ?1`).bind(updateId).run();
}

async function createAssistantJob(
  env: Env,
  message: TelegramAssistantTextQueueMessage,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO telegram_assistant_jobs
         (update_id, chat_id, user_id, source_message_id, input_text, state, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?6)
       ON CONFLICT(update_id) DO NOTHING`,
    )
    .bind(
      message.updateId,
      message.chatId,
      message.userId,
      message.sourceMessageId,
      message.text,
      now,
    )
    .run();
}

async function deleteAssistantJob(env: Env, updateId: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM telegram_assistant_jobs WHERE update_id = ?1`).bind(updateId).run();
}

export async function handleTelegramAssistantWebhook(
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
  if (!isAssistantFreeFormText(text)) return null;

  const userId = String(message.from.id);
  if (!isAllowedUser(env, userId)) return null;

  if (!(await claimTelegramUpdate(env, update.update_id))) return new Response("ok");

  const job: TelegramAssistantTextQueueMessage = {
    kind: "telegram_assistant_text",
    updateId: update.update_id,
    chatId: String(message.chat.id),
    userId,
    sourceMessageId: message.message_id,
    text: text.slice(0, 1600),
  };

  try {
    await createAssistantJob(env, job);
    await env.TASK_QUEUE.send(job as TaskQueueMessage);
  } catch (error) {
    try {
      await deleteAssistantJob(env, update.update_id);
      await releaseTelegramUpdate(env, update.update_id);
    } catch (cleanupError) {
      console.error("Assistant enqueue rollback failed", update.update_id, cleanupError);
    }
    console.error("Telegram assistant Queue enqueue failed", update.update_id, error);
    return new Response("temporary_failure", { status: 500 });
  }

  // Queue acceptance is the durable acknowledgement. This UX reply is best-effort:
  // losing it must not cause Telegram to replay the update and enqueue duplicate AI work.
  try {
    await sendTelegramMessage(
      env,
      job.chatId,
      "正在理解你的请求……",
      job.sourceMessageId,
    );
  } catch (error) {
    console.warn("Telegram assistant acknowledgement failed", update.update_id, error);
  }

  return new Response("ok");
}

async function getAssistantJob(env: Env, updateId: number): Promise<AssistantJobRow | null> {
  return env.DB
    .prepare(
      `SELECT update_id, chat_id, user_id, source_message_id, input_text, state,
              lease_token, lease_until, task_id, book_enqueued, response_text
       FROM telegram_assistant_jobs WHERE update_id = ?1`,
    )
    .bind(updateId)
    .first<AssistantJobRow>();
}

async function acquireAssistantJobLease(
  env: Env,
  updateId: number,
  token: string,
): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const until = new Date(now.getTime() + ASSISTANT_JOB_LEASE_MS).toISOString();
  const result = await env.DB
    .prepare(
      `UPDATE telegram_assistant_jobs
       SET state = 'processing', lease_token = ?2, lease_until = ?3, updated_at = ?4
       WHERE update_id = ?1
         AND state <> 'completed'
         AND (lease_until IS NULL OR lease_until <= ?4)`,
    )
    .bind(updateId, token, until, nowIso)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

async function releaseAssistantJobLease(
  env: Env,
  updateId: number,
  token: string,
): Promise<void> {
  await env.DB
    .prepare(
      `UPDATE telegram_assistant_jobs
       SET state = 'queued', lease_token = NULL, lease_until = NULL, updated_at = ?3
       WHERE update_id = ?1 AND lease_token = ?2 AND state <> 'completed'`,
    )
    .bind(updateId, token, new Date().toISOString())
    .run();
}

async function storeResponse(
  env: Env,
  updateId: number,
  token: string,
  responseText: string,
): Promise<void> {
  await env.DB
    .prepare(
      `UPDATE telegram_assistant_jobs
       SET response_text = ?3, updated_at = ?4
       WHERE update_id = ?1 AND lease_token = ?2`,
    )
    .bind(updateId, token, responseText.slice(0, 4096), new Date().toISOString())
    .run();
}

async function reserveBookTaskId(
  env: Env,
  updateId: number,
  token: string,
): Promise<string> {
  const current = await getAssistantJob(env, updateId);
  if (current?.task_id) return current.task_id;

  const taskId = crypto.randomUUID();
  const result = await env.DB
    .prepare(
      `UPDATE telegram_assistant_jobs
       SET task_id = ?3, updated_at = ?4
       WHERE update_id = ?1 AND lease_token = ?2 AND task_id IS NULL`,
    )
    .bind(updateId, token, taskId, new Date().toISOString())
    .run();
  if (Number(result.meta.changes ?? 0) > 0) return taskId;

  const after = await getAssistantJob(env, updateId);
  if (!after?.task_id) throw new Error("Could not reserve assistant book task id.");
  return after.task_id;
}

async function ensureTelegramTaskLink(
  env: Env,
  taskId: string,
  chatId: string,
  userId: string,
  sourceMessageId: number,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB
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
    .bind(taskId, chatId, userId, sourceMessageId, now)
    .run();
}

async function ensureBookTask(
  env: Env,
  job: AssistantJobRow,
  token: string,
  request: BookRequest,
): Promise<string> {
  const taskId = await reserveBookTaskId(env, job.update_id, token);
  const repo = new TaskRepository(env.DB);
  if (!(await repo.get(taskId))) {
    await repo.create(taskId, request);
  }
  await ensureTelegramTaskLink(
    env,
    taskId,
    job.chat_id,
    job.user_id,
    job.source_message_id,
  );
  return taskId;
}

async function ensureBookEnqueued(
  env: Env,
  job: AssistantJobRow,
  token: string,
  taskId: string,
): Promise<void> {
  const latest = await getAssistantJob(env, job.update_id);
  if (latest?.book_enqueued) return;

  await env.TASK_QUEUE.send({ kind: "book", taskId });
  await env.DB
    .prepare(
      `UPDATE telegram_assistant_jobs
       SET book_enqueued = 1, updated_at = ?3
       WHERE update_id = ?1 AND lease_token = ?2`,
    )
    .bind(job.update_id, token, new Date().toISOString())
    .run();
}

async function latestTaskForUser(env: Env, userId: string): Promise<TaskRecord | null> {
  const row = await env.DB
    .prepare(
      `SELECT task_id FROM telegram_task_links
       WHERE user_id = ?1
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!row?.task_id) return null;
  return new TaskRepository(env.DB).get(String(row.task_id));
}

function taskStatusText(task: TaskRecord | null): string {
  if (!task) return "没有找到可查看的 Kindle 任务。";
  const title = task.selectedCandidate?.title ?? task.request.query;
  switch (task.status) {
    case "queued":
    case "searching":
    case "downloading":
    case "staged":
    case "delivering":
      return `《${title}》仍在处理中。当前状态：${task.status}`;
    case "needs_selection":
      return `《${task.request.query}》还没有发送，需要先从候选版本中选择一本。`;
    case "needs_source":
      return `《${task.request.query}》没有找到可用来源，因此尚未发送。`;
    case "delivered":
      return `《${title}》已经发送到 Kindle。`;
    case "delivery_unknown":
      return `《${title}》的投递结果无法确认。系统已停止自动重发，以避免重复文档。`;
    case "failed":
      return `《${title}》处理失败${task.errorMessage ? `：${task.errorMessage.slice(0, 500)}` : "。"}`;
    case "cancelled":
      return `《${title}》已取消。`;
  }
}

async function completeAssistantJob(
  env: Env,
  updateId: number,
  token: string,
): Promise<void> {
  await env.DB
    .prepare(
      `UPDATE telegram_assistant_jobs
       SET state = 'completed', lease_token = NULL, lease_until = NULL, updated_at = ?3
       WHERE update_id = ?1 AND lease_token = ?2`,
    )
    .bind(updateId, token, new Date().toISOString())
    .run();
}

export async function processTelegramAssistantMessage(
  message: TelegramAssistantTextQueueMessage,
  env: Env,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram bot is not configured.");
  if (!isAllowedUser(env, message.userId)) return;

  const existing = await getAssistantJob(env, message.updateId);
  if (!existing || existing.state === "completed") return;

  const token = crypto.randomUUID();
  if (!(await acquireAssistantJobLease(env, message.updateId, token))) return;

  try {
    let job = await getAssistantJob(env, message.updateId);
    if (!job) return;

    const conversation = new TelegramConversationRepository(env.DB);
    let responseText = job.response_text ?? undefined;

    if (!responseText) {
      const history = await conversation.history(job.chat_id, job.user_id);
      let decision;
      try {
        decision = await decideAssistantAction(env, job.input_text, history);
      } catch (error) {
        console.error("Telegram queued assistant routing failed", job.update_id, error);
        responseText =
          "我现在没能可靠理解这句话，所以没有创建 Kindle 任务。请稍后重试，或者明确说出书名。";
      }

      if (decision) {
        if (decision.kind === "status") {
          responseText = taskStatusText(await latestTaskForUser(env, job.user_id));
        } else if (decision.kind === "book") {
          const taskId = await ensureBookTask(env, job, token, decision.request);
          job = (await getAssistantJob(env, job.update_id)) ?? job;
          await ensureBookEnqueued(env, job, token, taskId);
          responseText = `已确认《${decision.request.query}》，开始查找并发送到 Kindle。`;
        } else {
          responseText = decision.text;
        }
      }

      if (!responseText) {
        responseText = "我没有足够依据确认你的意思，所以没有创建 Kindle 任务。";
      }
      await storeResponse(env, job.update_id, token, responseText);
    } else if (job.task_id && !job.book_enqueued) {
      // Recover the crash window between task persistence and Queue acceptance.
      await ensureBookEnqueued(env, job, token, job.task_id);
    }

    await sendTelegramMessage(
      env,
      job.chat_id,
      responseText,
      job.source_message_id,
    );

    await conversation.append(job.chat_id, job.user_id, "user", job.input_text);
    await conversation.append(job.chat_id, job.user_id, "assistant", responseText);
    await completeAssistantJob(env, job.update_id, token);
  } catch (error) {
    try {
      await releaseAssistantJobLease(env, message.updateId, token);
    } catch (releaseError) {
      console.error("Could not release Telegram assistant job lease", message.updateId, releaseError);
    }
    throw error;
  }
}
