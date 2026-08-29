import type { BookRequest, Env, TaskQueueMessage } from "./domain";
import { TaskRepository } from "./repository";
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

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "book-to-kindle", environment: env.APP_ENV ?? "unknown" });
  }

  if (!isAuthorized(request, env)) return unauthorized();

  const repo = new TaskRepository(env.DB);

  if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, { status: 400 });
    }

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
    await env.TASK_QUEUE.send({ taskId: id });

    return json({ id, status: "queued" }, { status: 202 });
  }

  const match = url.pathname.match(/^\/api\/v1\/tasks\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && match) {
    const task = await repo.get(match[1]);
    if (!task) return json({ error: "not_found" }, { status: 404 });
    return json(task);
  }

  return json({ error: "not_found" }, { status: 404 });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },

  async queue(batch: MessageBatch<TaskQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processTask(message.body.taskId, {
          env,
          sources: [],
          delivery: undefined,
        });
        message.ack();
      } catch (error) {
        console.error("Queue task failed", message.body.taskId, error);
        message.retry();
      }
    }
  },
};
