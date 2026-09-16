import type { BookRequest, Env, TaskQueueMessage } from "./domain";
import { GmailDelivery, isGmailConfigured } from "./adapters/gmail";
import { GoogleBooksFreeSource } from "./adapters/googlebooks";
import { GutendexSource } from "./adapters/gutendex";
import { InternetArchivePublicSource } from "./adapters/internetarchive";
import { ZLibrarySource, isZLibraryConfigured } from "./adapters/zlibrary";
import { cancelTask, handleTelegramControlWebhook } from "./cancel";
import { isFreeTierGuardEnabled, UsageGuard } from "./guard";
import { withRelevanceGate } from "./relevance";
import { TaskRepository } from "./repository";
import { handleTelegramSettingsWebhook } from "./settings";
import {
  handleTelegramWebhook,
  isTelegramConfigured,
  notifyTelegramTaskState,
  processTelegramImageMessage,
} from "./telegram";
import { createReceiverSafeAi } from "./workers-ai";
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

function readIdempotencyKey(request: Request): { key?: string; error?: string } {
  const raw = request.headers.get("idempotency-key");
  if (raw === null) return {};
  const key = raw.trim();
  if (!key || key.length > 128) {
    return { error: "Idempotency-Key must be between 1 and 128 characters." };
  }
  return { key };
}

async function mappedTaskId(env: Env, key: string): Promise<string | null> {
  const row = await env.DB
    .prepare(`SELECT task_id FROM api_idempotency WHERE idempotency_key = ?1`)
    .bind(key)
    .first<Record<string, unknown>>();
  return row?.task_id ? String(row.task_id) : null;
}

async function reserveIdempotencyKey(env: Env, key: string, taskId: string): Promise<boolean> {
  const result = await env.DB
    .prepare(
      `INSERT INTO api_idempotency (idempotency_key, task_id, created_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    )
    .bind(key, taskId, new Date().toISOString())
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

async function releaseIdempotencyKey(env: Env, key: string, taskId: string): Promise<void> {
  await env.DB
    .prepare(`DELETE FROM api_idempotency WHERE idempotency_key = ?1 AND task_id = ?2`)
    .bind(key, taskId)
    .run();
}

async function cleanupFailedHttpTask(env: Env, taskId: string, idempotencyKey?: string): Promise<void> {
  const statements = [env.DB.prepare(`DELETE FROM tasks WHERE id = ?1`).bind(taskId)];
  if (idempotencyKey) {
    statements.push(
      env.DB
        .prepare(`DELETE FROM api_idempotency WHERE idempotency_key = ?1 AND task_id = ?2`)
        .bind(idempotencyKey, taskId),
    );
  }
  await env.DB.batch(statements);
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/telegram/webhook") {
    const settingsResponse = await handleTelegramSettingsWebhook(
      request.clone() as unknown as Request,
      env,
    );
    if (settingsResponse) return settingsResponse;

    const controlResponse = await handleTelegramControlWebhook(
      request.clone() as unknown as Request,
      env,
    );
    if (controlResponse) return controlResponse;
    return handleTelegramWebhook(request, env);
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return json({
      ok: true,
      service: "book-to-kindle",
      environment: env.APP_ENV ?? "unknown",
      resolvers: ["openlibrary", "google-books"],
      sources: ["gutendex", "google-books-free", "internet-archive-public", "zlibrary"],
      zlibrary: isZLibraryConfigured(env) ? "configured" : "not_configured",
      freeTierGuard: isFreeTierGuardEnabled(env) ? "enabled" : "disabled",
      defaultLanguage: "zh",
      delivery: isGmailConfigured(env) && env.KINDLE_EMAIL ? "gmail" : "not_configured",
      telegram: isTelegramConfigured(env) ? "configured" : "not_configured",
      vision: env.AI ? "workers_ai" : "not_configured",
    });
  }

  if (!isAuthorized(request, env)) return unauthorized();

  const repo = new TaskRepository(env.DB);
  const guard = new UsageGuard(env.DB);

  if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
    const check = await guard.checkCanCreateTask(env);
    if (!check.allowed) {
      return json(
        {
          error: "free_tier_guard_limit_reached",
          message: check.reason,
        },
        { status: 429 },
      );
    }

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

    const idempotency = readIdempotencyKey(request);
    if (idempotency.error) {
      return json({ error: "invalid_idempotency_key", message: idempotency.error }, { status: 400 });
    }

    if (idempotency.key) {
      const existingId = await mappedTaskId(env, idempotency.key);
      if (existingId) {
        const existingTask = await repo.get(existingId);
        if (existingTask) {
          return json(
            { id: existingTask.id, status: existingTask.status, idempotentReplay: true },
            { status: 202 },
          );
        }
        await releaseIdempotencyKey(env, idempotency.key, existingId);
      }
    }

    const id = crypto.randomUUID();
    if (idempotency.key) {
      const reserved = await reserveIdempotencyKey(env, idempotency.key, id);
      if (!reserved) {
        const winnerId = await mappedTaskId(env, idempotency.key);
        if (winnerId) {
          const winner = await repo.get(winnerId);
          if (winner) {
            return json(
              { id: winner.id, status: winner.status, idempotentReplay: true },
              { status: 202 },
            );
          }
        }
        return json(
          {
            error: "idempotency_request_in_progress",
            message: "Another request with the same Idempotency-Key is still being committed. Retry shortly.",
          },
          { status: 409, headers: { "retry-after": "1" } },
        );
      }
    }

    try {
      await repo.create(id, bookRequest);
    } catch (error) {
      if (idempotency.key) await releaseIdempotencyKey(env, idempotency.key, id);
      throw error;
    }

    try {
      await env.TASK_QUEUE.send({ kind: "book", taskId: id });
    } catch (error) {
      try {
        await cleanupFailedHttpTask(env, id, idempotency.key);
      } catch (cleanupError) {
        console.error("Could not clean up failed HTTP task enqueue", id, cleanupError);
      }
      console.error("HTTP task queue enqueue failed", id, error);
      return json(
        {
          error: "queue_unavailable",
          message: "The task was not accepted because Queue enqueue failed. It is safe to retry.",
        },
        { status: 503, headers: { "retry-after": "2" } },
      );
    }

    await guard.increment("tasks_created");
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

    const originalCandidates = task.candidates;
    await repo.update(task.id, {
      status: "queued",
      candidates: null,
      selectedCandidate: selected,
      errorMessage: null,
    });
    const latest = await repo.get(task.id);
    if (String(latest?.status) === "cancelled") {
      return json({ error: "task_cancelled", id: task.id }, { status: 409 });
    }

    try {
      await env.TASK_QUEUE.send({ kind: "book", taskId: task.id });
    } catch (error) {
      console.error("Selection queue enqueue failed", task.id, error);
      await repo.update(task.id, {
        status: "needs_selection",
        candidates: originalCandidates,
        selectedCandidate: null,
        errorMessage: "Selection was saved but Queue enqueue failed; please choose again.",
      });
      return json(
        { error: "queue_unavailable", id: task.id, status: "needs_selection" },
        { status: 503, headers: { "retry-after": "2" } },
      );
    }

    return json({ id: task.id, status: "queued", selectedCandidate: selected }, { status: 202 });
  }

  return json({ error: "not_found" }, { status: 404 });
}

function sources(env: Env) {
  return [
    new GutendexSource(),
    new GoogleBooksFreeSource(),
    new InternetArchivePublicSource(),
    ZLibrarySource.create(env),
  ].map(withRelevanceGate);
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
          const imageEnv: Env = { ...env, AI: createReceiverSafeAi(env.AI) };
          await processTelegramImageMessage(message.body, imageEnv);
        } catch (error) {
          console.error("Telegram image queue job failed", message.body.sourceMessageId, error);
        }
        message.ack();
        continue;
      }

      const taskId = message.body.taskId;
      let processingError: unknown;

      try {
        await processTask(taskId, {
          env,
          sources: sources(env),
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
