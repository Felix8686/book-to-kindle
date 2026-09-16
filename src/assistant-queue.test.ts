import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env, TaskQueueMessage } from "./domain";
import { handleTelegramAssistantWebhook } from "./assistant-queue";

interface JobRow {
  update_id: number;
  chat_id: string;
  user_id: string;
  source_message_id: number;
  input_text: string;
  state: string;
}

class FakeStatement {
  private params: unknown[] = [];

  constructor(private readonly db: FakeDb, private readonly sql: string) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO telegram_updates")) {
      const updateId = Number(this.params[0]);
      if (this.db.updates.has(updateId)) return { meta: { changes: 0 } };
      this.db.updates.add(updateId);
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes("DELETE FROM telegram_updates")) {
      const deleted = this.db.updates.delete(Number(this.params[0]));
      return { meta: { changes: deleted ? 1 : 0 } };
    }

    if (this.sql.includes("INSERT INTO telegram_assistant_jobs")) {
      const [updateId, chatId, userId, sourceMessageId, inputText] = this.params;
      const id = Number(updateId);
      if (this.db.jobs.has(id)) return { meta: { changes: 0 } };
      this.db.jobs.set(id, {
        update_id: id,
        chat_id: String(chatId),
        user_id: String(userId),
        source_message_id: Number(sourceMessageId),
        input_text: String(inputText),
        state: "queued",
      });
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes("DELETE FROM telegram_assistant_jobs")) {
      const deleted = this.db.jobs.delete(Number(this.params[0]));
      return { meta: { changes: deleted ? 1 : 0 } };
    }

    throw new Error(`Unexpected SQL run: ${this.sql}`);
  }
}

class FakeDb {
  updates = new Set<number>();
  jobs = new Map<number, JobRow>();

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

class FakeQueue {
  sent: TaskQueueMessage[] = [];
  fail = false;

  async send(message: TaskQueueMessage): Promise<void> {
    if (this.fail) throw new Error("queue unavailable");
    this.sent.push(message);
  }
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function env(db: FakeDb, queue: FakeQueue): Env {
  return {
    DB: db as unknown as D1Database,
    TASK_QUEUE: queue as unknown as Queue<TaskQueueMessage>,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_ALLOWED_USER_IDS: "42",
  } as unknown as Env;
}

function request(updateId = 1001): Request {
  return new Request("https://example.test/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "secret",
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: 77,
        from: { id: 42 },
        chat: { id: 42, type: "private" },
        text: "纳尼亚传奇",
      },
    }),
  });
}

describe("queued Telegram assistant webhook", () => {
  it("claims one update and never enqueues the same free-form message twice", async () => {
    const db = new FakeDb();
    const queue = new FakeQueue();
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const first = await handleTelegramAssistantWebhook(request(), env(db, queue));
    const second = await handleTelegramAssistantWebhook(request(), env(db, queue));

    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({
      kind: "telegram_assistant_text",
      updateId: 1001,
      userId: "42",
      text: "纳尼亚传奇",
    });
    expect(db.jobs.get(1001)?.input_text).toBe("纳尼亚传奇");
    expect(db.updates.has(1001)).toBe(true);
  });

  it("rolls back both durable job and update claim when Queue enqueue fails", async () => {
    const db = new FakeDb();
    const queue = new FakeQueue();
    queue.fail = true;
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const failed = await handleTelegramAssistantWebhook(request(), env(db, queue));

    expect(failed?.status).toBe(500);
    expect(db.jobs.has(1001)).toBe(false);
    expect(db.updates.has(1001)).toBe(false);

    queue.fail = false;
    const retried = await handleTelegramAssistantWebhook(request(), env(db, queue));
    expect(retried?.status).toBe(200);
    expect(queue.sent).toHaveLength(1);
    expect(db.jobs.has(1001)).toBe(true);
    expect(db.updates.has(1001)).toBe(true);
  });
});
