import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env, TaskRecord } from "../domain";
import { DeliveryFenceBlockedError, GmailDelivery } from "./gmail";

interface FenceRow {
  attempt_id: string;
  state: "started" | "accepted" | "unknown";
  updated_at: string;
  provider_message_id?: string | null;
  provider_thread_id?: string | null;
}

class FakeStatement {
  private params: unknown[] = [];

  constructor(private readonly db: FakeDb, private readonly sql: string) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO delivery_fences")) {
      const [taskId, attemptId, now] = this.params.map(String);
      if (this.db.fences.has(taskId)) return { meta: { changes: 0 } };
      this.db.fences.set(taskId, {
        attempt_id: attemptId,
        state: "started",
        updated_at: now,
      });
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes("UPDATE delivery_fences")) {
      const [taskId, attemptId, state, now, messageId, threadId] = this.params;
      const row = this.db.fences.get(String(taskId));
      if (!row || row.attempt_id !== String(attemptId)) return { meta: { changes: 0 } };
      row.state = state as FenceRow["state"];
      row.updated_at = String(now);
      row.provider_message_id = messageId ? String(messageId) : null;
      row.provider_thread_id = threadId ? String(threadId) : null;
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unexpected SQL run: ${this.sql}`);
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM delivery_fences")) {
      const row = this.db.fences.get(String(this.params[0]));
      return (row ? { ...row } : null) as T | null;
    }
    throw new Error(`Unexpected SQL first: ${this.sql}`);
  }
}

class FakeDb {
  fences = new Map<string, FenceRow>();

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function task(): TaskRecord {
  return {
    id: "task-1",
    status: "delivering",
    request: { query: "1984" },
    selectedCandidate: {
      id: "candidate-1",
      title: "1984",
      author: "George Orwell",
      language: "en",
      format: "epub",
      source: "test",
      sourceRef: "test",
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function objectBody(): R2ObjectBody {
  const bytes = new TextEncoder().encode("fake-epub");
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    httpMetadata: { contentType: "application/epub+zip" },
  } as unknown as R2ObjectBody;
}

function env(db: FakeDb): Env {
  return {
    DB: db as unknown as D1Database,
    GMAIL_CLIENT_ID: "client",
    GMAIL_CLIENT_SECRET: "secret",
    GMAIL_REFRESH_TOKEN: "refresh",
    GMAIL_FROM_EMAIL: "sender@example.com",
  } as unknown as Env;
}

describe("Gmail delivery fence", () => {
  it("returns the persisted receipt instead of sending a duplicate", async () => {
    const db = new FakeDb();
    let gmailCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
      }
      if (url.includes("gmail.googleapis.com")) {
        gmailCalls += 1;
        return new Response(JSON.stringify({ id: "msg-1", threadId: "thread-1" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const delivery = new GmailDelivery(env(db));
    const first = await delivery.deliver({
      task: task(),
      object: objectBody(),
      kindleEmail: "reader@kindle.com",
    });
    const second = await delivery.deliver({
      task: task(),
      object: objectBody(),
      kindleEmail: "reader@kindle.com",
    });

    expect(gmailCalls).toBe(1);
    expect(first.messageId).toBe("msg-1");
    expect(second.messageId).toBe("msg-1");
    expect(db.fences.get("task-1")?.state).toBe("accepted");
  });

  it("blocks automatic resend after an uncertain Gmail attempt", async () => {
    const db = new FakeDb();
    let gmailCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
      }
      if (url.includes("gmail.googleapis.com")) {
        gmailCalls += 1;
        throw new Error("network lost after request started");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const delivery = new GmailDelivery(env(db));
    await expect(
      delivery.deliver({ task: task(), object: objectBody(), kindleEmail: "reader@kindle.com" }),
    ).rejects.toThrow("network lost");

    expect(db.fences.get("task-1")?.state).toBe("unknown");

    await expect(
      delivery.deliver({ task: task(), object: objectBody(), kindleEmail: "reader@kindle.com" }),
    ).rejects.toBeInstanceOf(DeliveryFenceBlockedError);
    expect(gmailCalls).toBe(1);
  });
});
