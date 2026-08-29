import type { BookRequest, Env, TaskQueueMessage } from "./domain";
import { GmailDelivery, isGmailConfigured } from "./adapters/gmail";
import { GutendexSource } from "./adapters/gutendex";
import { cancelTask, handleTelegramControlWebhook } from "./cancel";
import { TaskRepository } from "./repository";
import {
  handleTelegramWebhook,
  isTelegramConfigured,
  notifyTelegramTaskState,
  processTelegramImageMessage,
} from "./telegram";
import { processTask } from "./workflow";

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, { status: 401 });
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.API_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.API_TOKEN}`;
}

function validateBookRequest(value: unknown): BookRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.query !== "string" || body.query.trim().length < 1 || body.query.length > 300) {
    return null;
  }

  const preferredFormat = body.preferredFormat;
  if (preferredFormat !== undefined && preferredFormat !== "epub" && preferredFormat !== "pdf") {
    return null;
  }

  return {
    query: body.query.trim(),
    author: typeof body.author === "string" ? body.author.trim().slice(0, 200) : undefined,
    language: typeof body.language === "string" ? body.language.trim().slice(0, 32) : undefined,
    preferredFormat: preferredFormat as BookRequest["preferredFormat"],
  };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/telegram/webhook") {
    const controlResponse = await handleTelegramControlWebhook(request.clone(), env);
    if (controlResponse) return controlResponse;
    return handleTelegramWebhook(request, env);
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return json({
      ok: true,
      service: "book-to-kindle",
      environment: env.APP_ENV ?? "unknown",
      source: "gutendex",
      delivery: isGmailConfigured(env) && env.KINDLE_EMAIL ? "gmail" : "not_configured",
      telegram: isTelegramConfigured(env) ? "configured" : "not_configured",
      vision: env.AI ? "workers_ai" : "not_configured",
    });
  }

  if (!isAuthorized(request, env)) return unauthorized();

  const repo = new TaskRepository(env.DB);

  if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
    const body = await readJson(request);
    const bookRequest = validateBookRequest(body);
    if (!bookRequest) {
      return json(
        {
          error: "invalid_request",
          message: "query is required; preferredFormat must be epub or pdf",
        },
        { status: 400 },
      );
    }

    const id = crypto.randomUUID();
    await repo.create(id, bookRequest);
    await env.TASK_QUEUE.send({ kind: "book", taskId: id });

    return json({ id, status: "queued" }, { status: 202 });
  }

  const cancelMatch = url.pathname.match(/^\/api\/v1\/tasks\/([0-9a-f-]+)\/cancel$/i);
  if (request.method === "POST" && cancelMatch) {
    const result = await cancelTask(cancelMatch[1], env);
    if (result.outcome === "not_found") {
      return json({ error: "not_found" }, { status: 404 });
    }
    if (result.outcome === "too_late") {
      return json(
        {
          error: "too_late_to_cancel",
          id: result.taskId,
          status: result.status,
          message:
            result.status === "delivered"
              ? "Delivery has already completed and cannot be remotely withdrawn from Gmail/Kindle."
              : "Gmail delivery has already started or its outcome is uncertain, so cancellation cannot be guaranteed.",
        },
        { status: 409 },
      );
    }
    if (result.outcome === "not_cancellable") {
      return json(
        {
          error: "task_not_cancellable",
          id: result.taskId,
          status: result.status,
        },
        { status: 409 },
      );
    }
    return json({ id: result.taskId, status: "cancelled" });
  }

  const taskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && taskMatch) {
    const task = await repo.get(taskMatch[1]);
    if (!task) return json({ error: "not_found" }, { status: 404 });
    return json(task);
  }

  const selectionMatch = url.pathname.match(/^\/api\/v1\/tasks\/([0-9a-f-]+)\/select$/i);
  if (request.method === "POST" && selectionMatch) {
    const task = await repo.get(selectionMatch[1]);
    if (!task) return json({ error: "not_found" }, { status: 404 });
    if (task.status !== "needs_selection" || !task.candidates?.length) {
      return json({ error: "task_not_waiting_for_selection" }, { status: 409 });
    }

    const body = await readJson(request);
    const candidateId = body && typeof body.candidateId === "string" ? body.candidateId : undefined;
    if (!candidateId) return json({ error: "candidateId_required" }, { status: 400 });

    const selected = task.candidates.find((candidate) => candidate.id === candidateId);
    if (!selected) return json({ error: "candidate_not_found" }, { status: 404 });

    await repo.update(task.id, {
      status: "queued",
      candidates: null,
      selectedCandidate: selected,
      errorMessage: null,
    });
    await env.TASK_QUEUE.send({ kind: "book", taskId: task.id });

    return json({ id: task.id, status: "queued", selectedCandidate: selected }, { status: 202 });
  }

  return json({ error: "not_found" }, { status: 404 });
}

function sources() {
  return [new GutendexSource()];
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },

  async queue(batch: MessageBatch<TaskQueueMessage>, env: Env): Promise<void> {
    const delivery = isGmailConfigured(env) ? new GmailDelivery(env) : undefined;

    for (const message of batch.messages) {
      if (message.body.kind === "telegram_image") {
        try {
          await processTelegramImageMessage(message.body, env);
        } catch (error) {
          console.error("Telegram image queue job failed", message.body.sourceMessageId, error);
        }
        // Vision jobs are intentionally not auto-retried: repeating AI inference can
        // waste the free quota and create duplicate buttons/tasks. The user can resend.
        message.ack();
        continue;
      }

      const taskId = message.body.taskId;
      let processingError: unknown;

      try {
        await processTask(taskId, {
          env,
          sources: sources(),
          delivery,
        });
      } catch (error) {
        processingError = error;
        console.error("Queue task failed", taskId, error);
      }

      try {
        await notifyTelegramTaskState(taskId, env);
      } catch (notificationError) {
        console.error("Telegram task notification failed", taskId, notificationError);
      }

      if (processingError) message.retry();
      else message.ack();
    }
  },
};
